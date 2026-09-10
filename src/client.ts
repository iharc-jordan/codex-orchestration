import { createHmac } from "node:crypto";
import { BridgeConfig, ConfigError, loadConfig, readToken } from "./config.js";

export type ControlOperation = "bind_project" | "enroll" | "register_pm" | "claim" | "revise" | "pause" | "resume" | "interrupt" | "cancel" | "review" | "handoff" | "operator_takeover";
export type ManagedPhase = "ready" | "active" | "review" | "accepted" | "waiting" | "cancelled";
export type ReviewDisposition = "accepted" | "rework" | "waiting" | "blocked";

export interface WorkerRoute {
  model: string;
  effort: string;
}

export interface ProjectBinding {
  project_id: string;
  project_number: number;
  status_field_id: string;
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
  [key: string]: unknown;
}

export interface ManagedState {
  revision: number;
  cursor?: number;
  latest_cursor?: number;
  paused: boolean;
  disabled: boolean;
  binding: ProjectBinding | null;
  assignments: Record<string, ManagedAssignment>;
  [key: string]: unknown;
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
  owner?: string;
  resources: string[];
  dependencies: string[];
  route: WorkerRoute;
  escalation_reason?: string;
  requirements_fingerprint: string;
  requirements_revision: number;
}

export interface ReviseArgs extends RevisionArgs {
  project_id: string;
  assignment_id: string;
  expected_ownership_revision: number;
  requirements_fingerprint?: string;
  requirements_revision?: number;
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

  async state(): Promise<ManagedState> {
    return this.request("/api/v1/managed/state", { method: "GET" }) as Promise<ManagedState>;
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
