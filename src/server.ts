import { execFileSync, spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { asBridgeError, BridgeError, ControlArgs, ControlOperation, ManagedClient } from "./client.js";
import { validateConfig } from "./config.js";
import { resolvedScriptPath, toWslPath } from "./paths.js";

const controlOperations: ControlOperation[] = ["bind_project", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review"];

const revisionProperty = { type: "integer", minimum: 0, description: "Current global or assignment revision required for compare-and-set." };
const assignmentIdProperty = { type: "string", minLength: 1, description: "Project item node ID used as the assignment key; the service verifies underlying issue ownership separately." };
const escalationReasonProperty = { type: "string", minLength: 1, description: "Required when selecting a route other than Luna/xhigh." };
const requirementsFingerprintProperty = { type: "string", minLength: 1, description: "sha256: followed by the lowercase SHA-256 digest of the exact UTF-8 GitHub issue body. Exclude the title; preserve all whitespace and line endings." };
const requirementsRevisionProperty = { type: "integer", minimum: 0, description: "Explicit PM material revision, distinct from the assignment revision; not parsed from issue text." };
const routeProperty = {
  type: "object",
  properties: {
    model: { type: "string", enum: ["gpt-5.6-luna", "gpt-5.6-terra"] },
    effort: { type: "string", enum: ["xhigh", "max"] }
  },
  required: ["model", "effort"],
  additionalProperties: false
};

const operationArgSchemas: Record<ControlOperation, Record<string, unknown>> = {
  bind_project: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      project: {
        type: "object",
        properties: {
          project_id: { type: "string", minLength: 1 },
          project_number: { type: "integer", minimum: 1 },
          status_field_id: { type: "string", minLength: 1 },
          status_options: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
          repositories: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }
        },
        required: ["project_id", "project_number", "status_field_id", "status_options", "repositories"],
        additionalProperties: false
      }
    },
    required: ["expected_revision", "project"],
    additionalProperties: true
  },
  enroll: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      assignment_id: assignmentIdProperty,
      project_item_id: { type: "string", minLength: 1 },
      native_issue_id: { type: "string", minLength: 1 },
      native_repository_id: { type: "string", minLength: 1 },
      repository: { type: "string", minLength: 1 },
      issue_number: { type: "integer", minimum: 1 },
      base_commit: { type: "string", pattern: "^[0-9a-fA-F]{40,64}$" },
      board_state: { type: "string", enum: ["READY"] },
      owner: { type: "string", minLength: 1 },
      resources: { type: "array", items: { type: "string" } },
      dependencies: { type: "array", items: { type: "string" } },
      route: routeProperty,
      escalation_reason: escalationReasonProperty,
      requirements_fingerprint: requirementsFingerprintProperty,
      requirements_revision: requirementsRevisionProperty
    },
    required: ["expected_revision", "assignment_id", "repository", "issue_number", "base_commit", "board_state", "resources", "dependencies", "route", "requirements_fingerprint", "requirements_revision"],
    additionalProperties: true
  },
  revise: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      assignment_id: assignmentIdProperty,
      changes: {
        type: "object",
        properties: {
          base_commit: { type: "string", pattern: "^[0-9a-fA-F]{40,64}$" },
          route: routeProperty,
          escalation_reason: escalationReasonProperty,
          resources: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          requirements: { type: "object" },
          requirements_fingerprint: requirementsFingerprintProperty,
          requirements_revision: requirementsRevisionProperty
        },
        additionalProperties: false
      }
    },
    required: ["expected_revision", "assignment_id", "changes"],
    additionalProperties: true
  },
  pause: {
    type: "object",
    properties: { expected_revision: revisionProperty, disable: { type: "boolean" }, reason: { type: "string" } },
    required: ["expected_revision"],
    additionalProperties: true
  },
  resume: {
    type: "object",
    properties: { expected_revision: revisionProperty, reason: { type: "string" } },
    required: ["expected_revision"],
    additionalProperties: true
  },
  interrupt: {
    type: "object",
    properties: { expected_revision: revisionProperty, assignment_id: assignmentIdProperty, reason: { type: "string", minLength: 1 } },
    required: ["expected_revision", "assignment_id", "reason"],
    additionalProperties: true
  },
  cancel: {
    type: "object",
    properties: { expected_revision: revisionProperty, assignment_id: assignmentIdProperty, reason: { type: "string" } },
    required: ["expected_revision", "assignment_id"],
    additionalProperties: true
  },
  review: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      assignment_id: assignmentIdProperty,
      disposition: { type: "string", enum: ["accepted", "rework", "waiting", "blocked"] },
      evidence: { type: "array", items: { type: "string", minLength: 1 } },
      reason: { type: "string" }
    },
    required: ["expected_revision", "assignment_id", "disposition"],
    additionalProperties: true
  }
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
    description: `Submit the ${operation} operation to Symphony. Supply a caller-owned request_id and the operation-specific args; the bridge preserves both and never retries writes.`,
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 256, description: "Caller-owned idempotency key. Reuse it only for the same input." },
        args: operationArgSchemas[operation]
      },
      required: ["request_id", "args"],
      additionalProperties: false
    }
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
          args: args.args as ControlArgs
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
