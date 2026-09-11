import { createHmac } from "node:crypto";
import { BridgeConfig, ConfigError, loadConfig, readToken } from "./config.js";

export type ControlOperation = "bind_project" | "enroll" | "register_pm" | "claim" | "revise" | "pause" | "resume" | "interrupt" | "cancel" | "review" | "handoff" | "operator_takeover";
export type ManagedPhase = "ready" | "active" | "review" | "accepted" | "waiting" | "cancelled";
export type ReviewDisposition = "accepted" | "rework" | "waiting" | "blocked";
export type ManagedStateView = "summary" | "detail" | "full";

export interface WorkerRoute {
  model: string;
  effort: string;
}

export interface ProjectBinding {
  project_id: string;
  project_number: number;
  status_field_id: string;
  projection_field_id?: string;
  status_options: Record<string, string>;
  repositories: string[];
}

export interface ManagedAssignment {
  assignment_id?: string;
  repository?: string;
  issue_number?: number;
  base_commit?: string;
  board_state?: string;
  phase?: ManagedPhase | string;
  revision?: number;
  control_revision?: number;
  route?: WorkerRoute;
  ownership?: { pm_id?: string | null; status?: string; ownership_revision?: number; [key: string]: unknown } | null;
  wait_reason?: string | null;
  last_report?: ManagedReport | null;
  reports?: Record<string, ManagedReport>;
  evidence?: string[];
  [key: string]: unknown;
}

export interface ManagedReport {
  report_id?: string;
  attempt_id?: string;
  kind?: string;
  summary?: string;
  evidence?: unknown[];
  [key: string]: unknown;
}

export interface ManagedProjectState {
  project_id?: string;
  [key: string]: unknown;
}

export interface ManagedUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cumulative_tokens?: number;
  inflight_tokens?: number;
  baseline_tokens?: number;
  overshoot_tokens?: number;
  cap_reached?: boolean;
  [key: string]: unknown;
}

export interface ManagedState {
  revision: number;
  cursor?: number;
  latest_cursor?: number;
  control_revision?: number;
  paused?: boolean;
  disabled?: boolean;
  binding?: ProjectBinding | null;
  principal?: { principal_id?: string; [key: string]: unknown } | null;
  projects?: Record<string, ManagedProjectState>;
  usage?: ManagedUsage;
  assignments?: Record<string, ManagedAssignment>;
  assignment?: ManagedAssignment;
  project?: ManagedProjectState;
  events?: ManagedEvent[];
  [key: string]: unknown;
}

export interface ManagedStateArgs {
  view?: ManagedStateView;
  project_id?: string;
  assignment_id?: string;
  include_history?: boolean;
}

export interface ManagedEvent {
  cursor?: number;
  event?: string;
  [key: string]: unknown;
}

export interface ManagedEvents {
  events: ManagedEvent[];
  cursor?: number;
  latest_cursor?: number;
  [key: string]: unknown;
}

export interface RevisionArgs {
  expected_revision: number;
  [key: string]: unknown;
}

export interface BindProjectArgs extends RevisionArgs {
  project: ProjectBinding;
}

export interface ResourceReference {
  kind: "repository" | "path" | "database" | "deployment" | "other";
  authority: string;
  identity: string;
  access: "read" | "write";
}

export interface EnrollArgs extends RevisionArgs {
  project_id: string;
  assignment_id: string;
  project_item_id?: string;
  native_issue_id?: string;
  native_repository_id?: string;
  repository: string;
  issue_number: number;
  base_commit: string;
  board_state: "READY" | string;
  resources: ResourceReference[];
  dependencies: string[];
  route: WorkerRoute;
  escalation_reason?: string;
  requirements_fingerprint?: string;
  requirements_revision: number;
  turn_limit?: number;
}

export interface ReviseArgs extends RevisionArgs {
  project_id: string;
  assignment_id: string;
  expected_ownership_revision: number;
  requirements_fingerprint?: string;
  requirements_revision?: number;
  changes?: {
    turn_limit?: number;
    turn_limit_reason?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PauseArgs extends RevisionArgs {
  scope?: "assignments" | "service";
  project_id?: string;
  assignments?: AssignmentFence[];
  disable?: boolean;
  reason?: string;
}

export interface ResumeArgs extends RevisionArgs {
  scope?: "assignments" | "service";
  project_id?: string;
  assignments?: AssignmentFence[];
  reason?: string;
}

export interface AssignmentFence {
  assignment_id: string;
  expected_revision: number;
  expected_ownership_revision: number;
}

export interface AssignmentControlArgs extends RevisionArgs {
  assignment_id: string;
  project_id: string;
  expected_ownership_revision: number;
  reason?: string;
}

export interface ReviewArgs extends RevisionArgs {
  project_id: string;
  assignment_id: string;
  expected_ownership_revision: number;
  disposition: ReviewDisposition;
  evidence: string[];
  peer_report_refs?: PeerReportRef[];
}

export interface PeerReportRef {
  source_assignment_id: string;
  source_attempt_id: string;
  report_id: string;
}

export interface RegisterPmArgs {
  display_name?: string;
}

export interface ClaimArgs {
  project_id: string;
  assignment_id: string;
  expected_revision: number;
  expected_ownership_revision: number;
}

export interface HandoffArgs {
  project_id: string;
  assignments: AssignmentFence[];
  destination_pm_id: string;
  reason: string;
}

export interface OperatorTakeoverArgs extends HandoffArgs {}

export type ControlArgsByOperation = {
  bind_project: BindProjectArgs;
  enroll: EnrollArgs;
  register_pm: RegisterPmArgs;
  claim: ClaimArgs;
  revise: ReviseArgs;
  pause: PauseArgs;
  resume: ResumeArgs;
  interrupt: AssignmentControlArgs;
  cancel: AssignmentControlArgs;
  review: ReviewArgs;
  handoff: HandoffArgs;
  operator_takeover: OperatorTakeoverArgs;
};

export type ControlArgs<O extends ControlOperation = ControlOperation> = O extends ControlOperation
  ? ControlArgsByOperation[O]
  : never;

export interface ControlRequest<O extends ControlOperation = ControlOperation> {
  request_id: string;
  operation: O;
  args: ControlArgs<O>;
}

export interface ControlResponse<O extends ControlOperation = ControlOperation> {
  operation: O;
  [key: string]: unknown;
}

export class BridgeError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}

const CONTROL_OPERATIONS = new Set<ControlOperation>([
  "bind_project", "enroll", "register_pm", "claim", "revise", "pause", "resume", "interrupt", "cancel", "review", "handoff", "operator_takeover"
]);

const MAX_RESPONSE_BYTES = 1_048_576;
const PM_CREDENTIAL_CONTEXT = "codex-orchestration-pm-v1:";

/** Derive the private capability sent to Symphony for one trusted Codex thread. */
export function derivePmCredential(operatorToken: string, threadId: string): string {
  const digest = createHmac("sha256", operatorToken)
    .update(`${PM_CREDENTIAL_CONTEXT}${threadId}`, "utf8")
    .digest("hex");
  return `pm-v1.${threadId}.${digest}`;
}

function endpointHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function safeMessage(status: number, body: unknown, token: string): string {
  if (status === 401 || status === 403) return "Symphony rejected the bridge credentials";
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && /^[a-z0-9_:-]{1,80}$/.test(code) && !code.includes(token)) {
      return `Symphony request failed: ${code}`;
    }
  }
  return `Symphony request failed with HTTP ${status}`;
}

const MANAGED_STATE_VIEWS = new Set<ManagedStateView>(["summary", "detail", "full"]);

function stateQuery(args: ManagedStateArgs): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new BridgeError("state_args_invalid", "state arguments must be an object");
  }
  if (args.view !== undefined && (typeof args.view !== "string" || !MANAGED_STATE_VIEWS.has(args.view as ManagedStateView))) {
    throw new BridgeError("state_view_invalid", "view must be summary, detail, or full");
  }
  for (const [name, value] of [["project_id", args.project_id], ["assignment_id", args.assignment_id]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      throw new BridgeError("state_filter_invalid", `${name} must be a non-empty string`);
    }
  }
  if (args.include_history !== undefined && typeof args.include_history !== "boolean") {
    throw new BridgeError("state_history_invalid", "include_history must be a boolean");
  }
  if (args.view === "detail" && args.assignment_id === undefined) {
    throw new BridgeError("state_assignment_required", "detail state requires assignment_id");
  }

  const query = new URLSearchParams();
  if (args.view !== undefined) query.set("view", args.view);
  if (args.project_id !== undefined) query.set("project_id", args.project_id);
  if (args.assignment_id !== undefined) query.set("assignment_id", args.assignment_id);
  if (args.include_history !== undefined) query.set("include_history", String(args.include_history));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export class ManagedClient {
  private readonly authorizationToken: string;

  constructor(
    private readonly config: BridgeConfig,
    operatorToken: string,
    readonly trustedThreadId?: string
  ) {
    this.authorizationToken = trustedThreadId
      ? derivePmCredential(operatorToken, trustedThreadId)
      : operatorToken;
  }

  static async fromConfig(trustedThreadId?: string): Promise<ManagedClient> {
    const config = await loadConfig();
    return new ManagedClient(config, await readToken(config), trustedThreadId);
  }

  async state(args: ManagedStateArgs = {}): Promise<ManagedState> {
    const query = stateQuery(args);
    return this.request(`/api/v1/managed/state${query}`, { method: "GET" }) as Promise<ManagedState>;
  }

  async events(after: number, waitMs: number, limit: number): Promise<ManagedEvents> {
    if (!Number.isInteger(after) || after < 0) throw new BridgeError("events_after_invalid", "after must be a non-negative integer");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new BridgeError("events_wait_invalid", "wait_ms must be between 0 and 60000");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError("events_limit_invalid", "limit must be between 1 and 100");
    return this.request(`/api/v1/managed/events?after=${after}&wait_ms=${waitMs}&limit=${limit}`, { method: "GET" }) as Promise<ManagedEvents>;
  }

  async control<O extends ControlOperation>(request: ControlRequest<O>): Promise<ControlResponse<O>> {
    if (!request || typeof request.request_id !== "string" || request.request_id.trim() === "") {
      throw new BridgeError("request_id_invalid", "request_id must be a non-empty string");
    }
    if (!request || typeof request.operation !== "string" || !CONTROL_OPERATIONS.has(request.operation as ControlOperation)) {
      throw new BridgeError("operation_invalid", "operation is not supported");
    }
    if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) {
      throw new BridgeError("args_invalid", "args must be an object");
    }
    return this.request("/api/v1/managed/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    }) as Promise<ControlResponse<O>>;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const bodyBytes = init.body ? Buffer.byteLength(String(init.body), "utf8") : 0;
    if (bodyBytes > this.config.maxInputBytes) throw new BridgeError("request_too_large", "request exceeds configured input limit");
    let response: Response;
    try {
      response = await fetch(`http://${endpointHost(this.config.host)}:${this.config.port}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.authorizationToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(65_000)
      });
    } catch {
      throw new BridgeError("upstream_unreachable", "Symphony loopback service is unavailable");
    }
    let parsed: unknown = null;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        parsed = null;
      } else {
        const chunks: Buffer[] = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => undefined);
              throw new BridgeError("upstream_response_too_large", "Symphony response exceeds the bridge limit", response.status);
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        const text = Buffer.concat(chunks).toString("utf8");
        parsed = text ? JSON.parse(text) : null;
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("upstream_invalid_response", response.ok ? "Symphony returned invalid JSON" : `Symphony request failed with HTTP ${response.status}`, response.status);
    }
    if (!response.ok) throw new BridgeError("upstream_error", safeMessage(response.status, parsed, this.authorizationToken), response.status);
    return parsed;
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof ConfigError) return new BridgeError(error.code, error.message);
  return new BridgeError("bridge_error", "The orchestration bridge could not complete the request");
}
