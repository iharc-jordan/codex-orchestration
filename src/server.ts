import { execFileSync, spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { asBridgeError, BridgeError, ControlOperation, ManagedClient } from "./client.js";
import { validateConfig } from "./config.js";
import { resolvedScriptPath, toWslPath } from "./paths.js";

const controlOperations: ControlOperation[] = ["bind_project", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review"];

const requestSchema = {
  type: "object",
  properties: {
    request_id: { type: "string", minLength: 1, description: "Caller-owned idempotency key. Reuse it only for the same input." },
    args: { type: "object", additionalProperties: true, description: "Operation-specific arguments, including expected_revision where required." }
  },
  required: ["request_id", "args"],
  additionalProperties: false
};

const tools = [
  {
    name: "orchestration_diagnostics",
    description: "Validate the local bridge configuration without contacting Symphony or exposing credentials.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "orchestration_state",
    description: "Read the compact managed Symphony state and latest durable event cursor.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "orchestration_events",
    description: "Read managed events after a cursor. wait_ms is bounded to 60000 and limit to 100.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0 },
        wait_ms: { type: "integer", minimum: 0, maximum: 60000 },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["after", "wait_ms", "limit"],
      additionalProperties: false
    }
  },
  ...controlOperations.map((operation) => ({
    name: `orchestration_${operation}`,
    description: `Submit the ${operation} operation to Symphony. The caller supplies request_id and operation-specific args; the bridge preserves both and never retries writes.`,
    inputSchema: requestSchema
  }))
];

function jsonResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown) {
  const safe = asBridgeError(error);
  return { isError: true, content: [{ type: "text", text: `${safe.code}: ${safe.message}` }] };
}

async function runBridge(): Promise<void> {
  const server = new Server(
    { name: "codex-orchestration", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name;
      if (name === "orchestration_diagnostics") return jsonResult(await validateConfig());
      const client = await ManagedClient.fromConfig();
      if (name === "orchestration_state") return jsonResult(await client.state());
      if (name === "orchestration_events") {
        const args = request.params.arguments ?? {};
        return jsonResult(await client.events(args.after as number, args.wait_ms as number, args.limit as number));
      }
      const operation = name.replace(/^orchestration_/, "") as ControlOperation;
      if (controlOperations.includes(operation)) {
        const args = request.params.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args) || !("args" in args)) {
          throw new BridgeError("args_invalid", "args is required and must be supplied by the caller");
        }
        return jsonResult(await client.control({
          request_id: args.request_id as string,
          operation,
          args: args.args as Record<string, unknown>
        }));
      }
      return errorResult(new Error("unknown tool"));
    } catch (error) {
      return errorResult(error);
    }
  });

  await server.connect(new StdioServerTransport());
}

function runWindowsLauncher(): void {
  const script = resolvedScriptPath(process.argv[1]);
  const configuredNode = process.env.CODEX_ORCHESTRATION_WSL_NODE?.trim();
  const wslNode = configuredNode || resolveWslNode();
  const environment = { ...process.env };
  for (const name of ["CODEX_ORCHESTRATION_CONFIG", "XDG_CONFIG_HOME"]) {
    const value = environment[name];
    if (value && /^[A-Za-z]:[\\/]/.test(value)) environment[name] = toWslPath(value);
  }
  const forwardedEnvironment = ["CODEX_ORCHESTRATION_CONFIG", "XDG_CONFIG_HOME"]
    .flatMap((name) => environment[name] ? [`${name}=${environment[name]}`] : []);
  const child = spawn("wsl.exe", ["-d", "Ubuntu", "--", "env", ...forwardedEnvironment, wslNode, script, ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: true,
    env: environment
  });
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));
  process.once("exit", () => {
    if (!child.killed) child.kill("SIGTERM");
  });
  child.once("close", (code) => {
    process.exitCode = code ?? 1;
  });
}

function resolveWslNode(): string {
  let output: string;
  try {
    output = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node -p process.execPath"], {
      encoding: "utf8",
      windowsHide: true
    });
  } catch {
    throw new Error("Could not resolve a Linux Node runtime in the Ubuntu WSL environment; set CODEX_ORCHESTRATION_WSL_NODE");
  }
  const candidate = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/(?!mnt\/)[^\r\n]+\/node$/.test(line)).pop();
  if (!candidate) throw new Error("Ubuntu WSL did not return a Linux Node runtime; set CODEX_ORCHESTRATION_WSL_NODE");
  return candidate;
}

if (process.platform === "win32") runWindowsLauncher();
else await runBridge();
