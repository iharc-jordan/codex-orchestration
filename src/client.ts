import { BridgeConfig, ConfigError, loadConfig, readToken } from "./config.js";

export type ControlOperation = "bind_project" | "enroll" | "revise" | "pause" | "resume" | "interrupt" | "cancel" | "review";

export interface ControlRequest {
  request_id: string;
  operation: ControlOperation;
  args: Record<string, unknown>;
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
  "bind_project", "enroll", "revise", "pause", "resume", "interrupt", "cancel", "review"
]);

const MAX_RESPONSE_BYTES = 1_048_576;

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
  constructor(private readonly config: BridgeConfig, private readonly token: string) {}

  static async fromConfig(): Promise<ManagedClient> {
    const config = await loadConfig();
    return new ManagedClient(config, await readToken(config));
  }

  async state(): Promise<unknown> {
    return this.request("/api/v1/managed/state", { method: "GET" });
  }

  async events(after: number, waitMs: number, limit: number): Promise<unknown> {
    if (!Number.isInteger(after) || after < 0) throw new BridgeError("events_after_invalid", "after must be a non-negative integer");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000) throw new BridgeError("events_wait_invalid", "wait_ms must be between 0 and 60000");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError("events_limit_invalid", "limit must be between 1 and 100");
    return this.request(`/api/v1/managed/events?after=${after}&wait_ms=${waitMs}&limit=${limit}`, { method: "GET" });
  }

  async control(request: ControlRequest): Promise<unknown> {
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
    });
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const bodyBytes = init.body ? Buffer.byteLength(String(init.body), "utf8") : 0;
    if (bodyBytes > this.config.maxInputBytes) throw new BridgeError("request_too_large", "request exceeds configured input limit");
    let response: Response;
    try {
      response = await fetch(`http://${endpointHost(this.config.host)}:${this.config.port}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${this.token}` },
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
    if (!response.ok) throw new BridgeError("upstream_error", safeMessage(response.status, parsed, this.token), response.status);
    return parsed;
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof ConfigError) return new BridgeError(error.code, error.message);
  return new BridgeError("bridge_error", "The orchestration bridge could not complete the request");
}
