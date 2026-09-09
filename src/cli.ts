import { CheckoutError, prepareTrustedCheckout, type CheckoutOptions } from "./checkout.js";
import { LifecycleError, diagnostics, pause, rollback, resume, setup, start, stop, uninstall, upgrade, validateConfigForHost, type LifecycleOptions } from "./lifecycle.js";

const usage = `Usage:
  codex-orchestration validate-config
  codex-orchestration diagnostics [--root PATH] [--service-name NAME]
  codex-orchestration setup --executable PATH --workflow PATH [--version VERSION] [--port PORT]
  codex-orchestration start [setup options]
  codex-orchestration pause | resume | stop | rollback | uninstall
  codex-orchestration upgrade --executable PATH [--version VERSION]
  codex-orchestration checkout --input PATH [--policy PATH]`;

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
