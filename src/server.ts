import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asBridgeError, BridgeError, ControlArgs, ControlOperation, ManagedClient, type ManagedStateArgs } from "./client.js";
import { validateConfig } from "./config.js";

const controlOperations: ControlOperation[] = ["register_pm", "claim", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review", "handoff"];
const operatorOnlyOperations = new Set<ControlOperation>(["bind_project", "operator_takeover"]);
const pmOperations = new Set<ControlOperation>(["register_pm", "claim", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review", "handoff"]);

const revisionProperty = { type: "integer", minimum: 0, description: "Current global or assignment revision required for compare-and-set." };
const assignmentIdProperty = { type: "string", minLength: 1, description: "Stable managed assignment identifier; the service verifies the canonical issue identity separately." };
const projectIdProperty = { type: "string", minLength: 1, description: "Explicit GitHub Project identity for this operation." };
const ownershipRevisionProperty = { type: "integer", minimum: 0, description: "Current assignment ownership revision required for compare-and-set." };
const assignmentFenceSchema = {
  type: "object",
  properties: {
    assignment_id: assignmentIdProperty,
    expected_revision: revisionProperty,
    expected_ownership_revision: ownershipRevisionProperty
  },
  required: ["assignment_id", "expected_revision", "expected_ownership_revision"],
  additionalProperties: false
};
const assignmentFencesProperty = { type: "array", minItems: 1, items: assignmentFenceSchema };
const escalationReasonProperty = { type: "string", minLength: 1, description: "Required when selecting a route other than Luna/xhigh." };
const requirementsFingerprintProperty = { type: "string", minLength: 1, description: "Optional exact issue-body fingerprint. Symphony resolves this from GitHub when omitted and validates any supplied value; manual hashing is unnecessary." };
const requirementsRevisionProperty = { type: "integer", minimum: 0, description: "Explicit PM material revision, distinct from the assignment revision; not parsed from issue text." };
const resourcesProperty = {
  type: "array",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["repository", "path", "database", "deployment", "other"] },
      authority: { type: "string", minLength: 1 },
      identity: { type: "string", minLength: 1 },
      access: { type: "string", enum: ["read", "write"] }
    },
    required: ["kind", "authority", "identity", "access"],
    additionalProperties: false
  }
};
const routeProperty = {
  type: "object",
  properties: {
    model: { type: "string", enum: ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"] },
    effort: { type: "string", enum: ["xhigh", "max"] }
  },
  required: ["model", "effort"],
  additionalProperties: false
};
const peerReportRefSchema = {
  type: "object",
  properties: {
    source_assignment_id: { type: "string", minLength: 1 },
    source_attempt_id: { type: "string", minLength: 1 },
    report_id: { type: "string", minLength: 1 }
  },
  required: ["source_assignment_id", "source_attempt_id", "report_id"],
  additionalProperties: false
};
const peerReportRefsProperty = {
  type: "array",
  maxItems: 8,
  uniqueItems: true,
  items: peerReportRefSchema,
  description: "Optional references to bounded peer reports. The runtime verifies project, attempt, report, and revision scope; references are evidence, not authorization."
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
          projection_field_id: { type: "string", minLength: 1 },
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
  register_pm: {
    type: "object",
    properties: {
      display_name: { type: "string", minLength: 1, maxLength: 200, description: "Optional display label; PM identity comes from the trusted Codex thread metadata." }
    },
    required: [],
    additionalProperties: false
  },
  claim: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
      assignment_id: assignmentIdProperty,
      expected_revision: revisionProperty,
      expected_ownership_revision: ownershipRevisionProperty
    },
    required: ["project_id", "assignment_id", "expected_revision", "expected_ownership_revision"],
    additionalProperties: true
  },
  enroll: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      project_id: projectIdProperty,
      assignment_id: assignmentIdProperty,
      project_item_id: { type: "string", minLength: 1 },
      native_issue_id: { type: "string", minLength: 1 },
      native_repository_id: { type: "string", minLength: 1 },
      repository: { type: "string", minLength: 1 },
      issue_number: { type: "integer", minimum: 1 },
      base_commit: { type: "string", pattern: "^[0-9a-fA-F]{40,64}$" },
      board_state: { type: "string", enum: ["READY"] },
      resources: resourcesProperty,
      dependencies: { type: "array", items: { type: "string" } },
      route: routeProperty,
      escalation_reason: escalationReasonProperty,
      requirements_fingerprint: requirementsFingerprintProperty,
      requirements_revision: requirementsRevisionProperty,
      turn_limit: { type: "integer", minimum: 1, maximum: 20, description: "Initial lifetime turn allowance; defaults to 20. Retries share this count." }
    },
    required: ["expected_revision", "project_id", "assignment_id", "repository", "issue_number", "base_commit", "board_state", "resources", "dependencies", "route", "requirements_revision"],
    additionalProperties: true
  },
  revise: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      expected_ownership_revision: ownershipRevisionProperty,
      project_id: projectIdProperty,
      assignment_id: assignmentIdProperty,
      changes: {
        type: "object",
        properties: {
          base_commit: { type: "string", pattern: "^[0-9a-fA-F]{40,64}$" },
          route: routeProperty,
          escalation_reason: escalationReasonProperty,
          resources: resourcesProperty,
          dependencies: { type: "array", items: { type: "string" } },
          requirements: { type: "object" },
          requirements_fingerprint: { type: "string", minLength: 1, description: "Required when the issue body changes: sha256: plus the SHA-256 digest of its exact UTF-8 body. Omission preserves the enrolled fingerprint; only enrollment resolves it automatically." },
          requirements_revision: requirementsRevisionProperty,
          turn_limit: { type: "integer", minimum: 1, maximum: 100, description: "Explicit increase to the absolute lifetime turn allowance. Must exceed the current limit; preserves turns already reserved. Requires turn_limit_reason." },
          turn_limit_reason: { type: "string", minLength: 1, description: "Required justification for increasing the lifetime turn allowance." }
        },
        additionalProperties: false
      }
    },
    required: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "changes"],
    additionalProperties: true
  },
  pause: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["assignments"] },
      project_id: projectIdProperty,
      assignments: assignmentFencesProperty,
      reason: { type: "string" }
    },
    required: ["scope", "project_id", "assignments"],
    additionalProperties: false
  },
  resume: {
    type: "object",
    properties: {
      scope: { type: "string", enum: ["assignments"] },
      project_id: projectIdProperty,
      assignments: assignmentFencesProperty,
      reason: { type: "string" }
    },
    required: ["scope", "project_id", "assignments"],
    additionalProperties: false
  },
  interrupt: {
    type: "object",
    properties: { expected_revision: revisionProperty, expected_ownership_revision: ownershipRevisionProperty, project_id: projectIdProperty, assignment_id: assignmentIdProperty, reason: { type: "string", minLength: 1 } },
    required: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "reason"],
    additionalProperties: true
  },
  cancel: {
    type: "object",
    properties: { expected_revision: revisionProperty, expected_ownership_revision: ownershipRevisionProperty, project_id: projectIdProperty, assignment_id: assignmentIdProperty, reason: { type: "string" } },
    required: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id"],
    additionalProperties: true
  },
  review: {
    type: "object",
    properties: {
      expected_revision: revisionProperty,
      expected_ownership_revision: ownershipRevisionProperty,
      project_id: projectIdProperty,
      assignment_id: assignmentIdProperty,
      disposition: { type: "string", enum: ["accepted", "rework", "waiting", "blocked"] },
      evidence: { type: "array", items: { type: "string", minLength: 1 }, description: "Acceptance proof for the current revision. Required for accepted review, including inactive, reconciled context_needed assignments in WAITING." },
      peer_report_refs: peerReportRefsProperty,
      reason: { type: "string" }
    },
    required: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "disposition"],
    additionalProperties: true
  },
  handoff: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
      assignments: assignmentFencesProperty,
      destination_pm_id: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 }
    },
    required: ["project_id", "assignments", "destination_pm_id", "reason"],
    additionalProperties: false
  },
  operator_takeover: {
    type: "object",
    properties: {
      project_id: projectIdProperty,
      assignments: assignmentFencesProperty,
      destination_pm_id: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 }
    },
    required: ["project_id", "assignments", "destination_pm_id", "reason"],
    additionalProperties: false
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
    description: "Read managed Symphony state. Summary is the default compact view; detail requires assignment_id and full is an explicit diagnostic view. Without Codex _meta.threadId this uses operator authentication and cannot identify a PM.",
    inputSchema: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["summary", "detail", "full"], default: "summary" },
        project_id: { type: "string", minLength: 1, description: "Optional Project scope for the state read." },
        assignment_id: { type: "string", minLength: 1, description: "Optional assignment scope; required for the detail view." },
        include_history: { type: "boolean", default: false, description: "Include historical assignment records when supported by the selected view; detail already includes the selected assignment's full reports." }
      },
      allOf: [{
        if: { required: ["view"], properties: { view: { const: "detail" } } },
        then: { required: ["assignment_id"] }
      }],
      additionalProperties: false
    }
  },
  {
    name: "orchestration_events",
    description: "Read managed events after a cursor. Without Codex _meta.threadId this uses operator authentication and cannot identify a PM. wait_ms is bounded to 60000 and limit to 100.",
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
    description: `Submit the ${operation} operation to Symphony using the trusted Codex thread identity in request metadata. Supply a caller-owned request_id and the operation-specific args; the bridge preserves both and never retries writes.`,
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

const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type JsonObject = Record<string, unknown>;
type NativeCaller = { threadId: string };

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTurnMetadata(value: unknown): JsonObject | undefined {
  if (isJsonObject(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function nativeCaller(request: { params: { _meta?: unknown } }): NativeCaller | undefined {
  const meta = request.params?._meta;
  if (meta === undefined) return undefined;
  if (!isJsonObject(meta)) throw new BridgeError("caller_identity_invalid", "MCP request metadata must be an object");
  const rawThreadId = meta.threadId;
  if (rawThreadId === undefined) return undefined;
  if (typeof rawThreadId !== "string" || !THREAD_ID_PATTERN.test(rawThreadId)) {
    throw new BridgeError("caller_identity_invalid", "MCP metadata threadId must be a UUID");
  }
  const turnMetadata = parseTurnMetadata(meta["x-codex-turn-metadata"]);
  const turnThreadId = turnMetadata?.thread_id;
  if (typeof turnThreadId === "string" && THREAD_ID_PATTERN.test(turnThreadId) && turnThreadId !== rawThreadId) {
    throw new BridgeError("caller_identity_mismatch", "MCP metadata threadId does not match x-codex-turn-metadata.thread_id");
  }
  return { threadId: rawThreadId };
}

function requireNativePm(operation: ControlOperation, caller: NativeCaller | undefined, args: unknown): NativeCaller {
  if ((operation === "pause" || operation === "resume") && isJsonObject(args) && args.scope === "service") {
    throw new BridgeError("operator_required", "service pause and resume require the operator CLI");
  }
  if (!caller) {
    throw new BridgeError("caller_identity_required", `${operation} requires Codex _meta.threadId; operator authentication is not a PM fallback`);
  }
  return caller;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown) {
  const safe = asBridgeError(error);
  return { isError: true, content: [{ type: "text", text: `${safe.code}: ${safe.message}` }] };
}

export async function runBridge(testRoot?: string): Promise<void> {
  const server = new Server(
    { name: "codex-orchestration", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name;
      const caller = nativeCaller(request as typeof request & { params: { _meta?: unknown } });
      if (name === "orchestration_diagnostics") return jsonResult(await validateConfig(testRoot));
      if (name === "orchestration_state") {
        const client = await ManagedClient.fromConfig(caller?.threadId, testRoot);
        const args = request.params.arguments ?? {};
        return jsonResult(await client.state(args as ManagedStateArgs));
      }
      if (name === "orchestration_events") {
        const client = await ManagedClient.fromConfig(caller?.threadId, testRoot);
        const args = request.params.arguments ?? {};
        return jsonResult(await client.events(args.after as number, args.wait_ms as number, args.limit as number));
      }
      const operation = name.replace(/^orchestration_/, "") as ControlOperation;
      if (operatorOnlyOperations.has(operation)) {
        throw new BridgeError("operator_required", `${operation} requires the operator CLI`);
      }
      if (pmOperations.has(operation)) {
        const args = request.params.arguments ?? {};
        const pmCaller = requireNativePm(operation, caller, isJsonObject(args) ? args.args : undefined);
        if (!isJsonObject(args) || !("args" in args)) {
          throw new BridgeError("args_invalid", "args is required and must be supplied by the caller");
        }
        const client = await ManagedClient.fromConfig(pmCaller.threadId, testRoot);
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

  // The process belongs to this stdio connection. An outstanding HTTP request
  // must not keep an orphaned bridge alive after its Codex caller disconnects.
  server.onclose = () => process.exit(0);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runBridge();
}
