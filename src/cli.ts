import { readFile } from "node:fs/promises";
import { CheckoutError, prepareTrustedCheckout, type CheckoutOptions } from "./checkout.js";
import { BridgeError, ManagedClient, type ControlOperation, type ControlRequest } from "./client.js";
import { LifecycleError, diagnostics, pause, rollback, resume, setup, start, stop, uninstall, upgrade, validateConfigForHost, type LifecycleOptions } from "./lifecycle.js";

const usage = `Usage:
  codex-orchestration validate-config
  codex-orchestration diagnostics [--root PATH] [--service-name NAME]
  codex-orchestration setup --executable PATH --workflow PATH [--version VERSION] [--port PORT]
  codex-orchestration start [setup options]
  codex-orchestration pause | resume | stop | rollback | uninstall
  codex-orchestration upgrade --executable PATH [--version VERSION]
  codex-orchestration control --input PATH
  codex-orchestration checkout --input PATH [--policy PATH]`;

const OPERATOR_CONTROL_OPERATIONS = new Set<ControlOperation>(["bind_project", "pause", "resume", "operator_takeover"]);
const CONTROL_INPUT_MAX_BYTES = 1_048_576;

function parseOptions(values: string[]): LifecycleOptions {
  const options: LifecycleOptions = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--")) throw new LifecycleError("usage", `unexpected argument: ${name}`);
    const key = name.slice(2);
    if (key === "help") throw new LifecycleError("usage", usage);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new LifecycleError("usage", `${name} requires a value`);
    if (key === "executable") options.executable = value;
    else if (key === "workflow") options.workflow = value;
    else if (key === "version") options.version = value;
    else if (key === "host") options.host = value;
    else if (key === "port") options.port = Number(value);
    else if (key === "token-file") options.tokenFile = value;
    else if (key === "root") options.root = value;
    else if (key === "service-name") options.serviceName = value;
    else throw new LifecycleError("usage", `unknown option: ${name}`);
  }
  if (options.root) process.env.CODEX_ORCHESTRATION_HOME = options.root;
  if (options.serviceName) process.env.CODEX_ORCHESTRATION_SERVICE_NAME = options.serviceName;
  return options;
}

function parseCheckoutOptions(values: string[]): CheckoutOptions {
  let inputFile: string | undefined;
  let policyFile: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--help") throw new CheckoutError("usage", usage);
    if (name !== "--input" && name !== "--policy") throw new CheckoutError("usage", `unknown option: ${name}`);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new CheckoutError("usage", `${name} requires a value`);
    if (name === "--input") inputFile = value;
    else policyFile = value;
  }
  if (!inputFile) throw new CheckoutError("usage", "checkout requires --input PATH");
  return { inputFile, policyFile };
}

function parseControlOptions(values: string[]): string {
  let inputFile: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--help") throw new LifecycleError("usage", usage);
    if (name !== "--input") throw new LifecycleError("usage", `unknown option: ${name}`);
    if (inputFile) throw new LifecycleError("usage", "control accepts exactly one --input PATH");
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new LifecycleError("usage", `${name} requires a value`);
    inputFile = value;
  }
  if (!inputFile) throw new LifecycleError("usage", "control requires --input PATH");
  return inputFile;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readControlEnvelope(inputFile: string): Promise<ControlRequest> {
  let contents: string;
  try {
    const bytes = await readFile(inputFile);
    if (bytes.byteLength > CONTROL_INPUT_MAX_BYTES) throw new LifecycleError("control_input_too_large", "control input exceeds the private envelope limit");
    contents = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError("control_input_unreadable", "control input could not be read");
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new LifecycleError("control_input_invalid", "control input is not valid JSON");
  }
  if (!plainObject(value)) throw new LifecycleError("control_input_invalid", "control input must be a JSON object");
  const envelopeKeys = Object.keys(value);
  if (envelopeKeys.some((key) => key !== "request_id" && key !== "operation" && key !== "args")) {
    throw new LifecycleError("control_input_invalid", "control input must contain only request_id, operation, and args");
  }

  const requestId = value.request_id;
  const operation = value.operation;
  const args = value.args;
  if (typeof requestId !== "string" || requestId.trim() === "" || requestId.length > 256) {
    throw new LifecycleError("control_input_invalid", "control input request_id must be a non-empty string of at most 256 characters");
  }
  if (typeof operation !== "string" || !OPERATOR_CONTROL_OPERATIONS.has(operation as ControlOperation)) {
    throw new LifecycleError("operator_required", "control accepts bind_project, service pause/resume, and operator_takeover only");
  }
  if (!plainObject(args)) throw new LifecycleError("control_input_invalid", "control input args must be a JSON object");
  if ((operation === "pause" || operation === "resume") && args.scope !== "service") {
    throw new LifecycleError("operator_required", `${operation} control input must use scope service`);
  }
  return { request_id: requestId, operation: operation as ControlOperation, args } as ControlRequest;
}

async function control(inputFile: string): Promise<unknown> {
  const request = await readControlEnvelope(inputFile);
  try {
    // The operator token is loaded only from the trusted bridge configuration;
    // the private envelope carries no credential or caller identity.
    const client = await ManagedClient.fromConfig();
    return await client.control(request);
  } catch (error) {
    if (error instanceof BridgeError) throw new LifecycleError(error.code, error.message, error.status);
    throw error;
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

try {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "validate-config") {
    const diagnostic = await validateConfigForHost();
    print(diagnostic);
    process.exitCode = diagnostic.valid ? 0 : 1;
  } else if (command === "help") {
    console.log(usage);
    process.exitCode = 0;
  } else if (command === "checkout") {
    print(await prepareTrustedCheckout(parseCheckoutOptions(args)));
  } else if (command === "control") {
    print(await control(parseControlOptions(args)));
  } else {
    const options = parseOptions(args);
    if (command === "diagnostics") print(await diagnostics(options));
    else if (command === "setup") print(await setup(options));
    else if (command === "start") print(await start(options));
    else if (command === "pause") print(await pause(options));
    else if (command === "resume") print(await resume(options));
    else if (command === "stop") print(await stop(options));
    else if (command === "upgrade") print(await upgrade(options));
    else if (command === "rollback") print(await rollback(options));
    else if (command === "uninstall") print(await uninstall(options));
    else throw new LifecycleError("usage", `unknown command: ${command}\n${usage}`);
  }
} catch (error) {
  const lifecycle = error instanceof LifecycleError || error instanceof CheckoutError ? error : new LifecycleError("lifecycle_error", "The orchestration lifecycle command failed");
  console.error(`${lifecycle.code}: ${lifecycle.message}`);
  process.exitCode = lifecycle.code === "usage" ? 2 : 1;
}
