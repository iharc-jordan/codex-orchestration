import { readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fromWslPath } from "./paths.js";

export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024;

export interface BridgeConfig {
  host: string;
  port: number;
  tokenFile: string;
  maxInputBytes: number;
}

export interface ConfigDiagnostic {
  valid: boolean;
  configFile: string;
  host?: string;
  port?: number;
  tokenFile?: string;
  maxInputBytes?: number;
  error?: string;
}

export class ConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function configFilePath(): string {
  const explicit = process.env.CODEX_ORCHESTRATION_CONFIG;
  if (explicit?.trim()) return resolve(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "codex-orchestration", "config.json");
}

function safeConfigError(error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  return new ConfigError("config_invalid", "Configuration could not be read");
}

function isLoopbackHost(host: unknown): host is string {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export async function loadConfig(): Promise<BridgeConfig> {
  const path = configFilePath();
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("config_missing", `Configuration file not found: ${path}`);
    }
    throw safeConfigError(error);
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("config_invalid", "Configuration must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const host = raw.host;
  const port = raw.port;
  const token = raw.token_file;
  const maxInputBytes = raw.max_input_bytes ?? DEFAULT_MAX_INPUT_BYTES;

  if (!isLoopbackHost(host)) {
    throw new ConfigError("config_non_loopback", "host must be localhost, 127.0.0.1, or ::1");
  }
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new ConfigError("config_port_invalid", "port must be an integer from 1 through 65535");
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new ConfigError("config_token_invalid", "token_file must be a non-empty path");
  }
  if (!Number.isInteger(maxInputBytes) || (maxInputBytes as number) < 1024 || (maxInputBytes as number) > DEFAULT_MAX_INPUT_BYTES) {
    throw new ConfigError("config_input_limit_invalid", "max_input_bytes must be between 1024 and 16384");
  }

  const tokenFile = platform() === "win32" && /^\/mnt\/[A-Za-z]\//.test(token)
    ? fromWslPath(token)
    : isAbsolute(token) ? resolve(token) : resolve(dirname(path), token);
  await verifyTokenFile(tokenFile);
  return { host, port: port as number, tokenFile, maxInputBytes: maxInputBytes as number };
}

async function verifyTokenFile(tokenFile: string): Promise<void> {
  let details;
  try {
    details = await stat(tokenFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError("config_token_missing", "token_file does not exist");
    }
    throw new ConfigError("config_token_unreadable", "token_file could not be inspected");
  }
  if (!details.isFile()) throw new ConfigError("config_token_invalid", "token_file must be a regular file");
  if (platform() !== "win32" && (details.mode & 0o077) !== 0) {
    throw new ConfigError("config_token_permissions", "token_file permissions are too broad; use owner-only permissions");
  }
}

export async function readToken(config: BridgeConfig): Promise<string> {
  try {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!token) throw new ConfigError("config_token_empty", "token_file is empty");
    return token;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config_token_unreadable", "token_file could not be read");
  }
}

export async function validateConfig(): Promise<ConfigDiagnostic> {
  const configFile = configFilePath();
  try {
    const config = await loadConfig();
    return { valid: true, configFile, host: config.host, port: config.port, tokenFile: config.tokenFile, maxInputBytes: config.maxInputBytes };
  } catch (error) {
    const safe = safeConfigError(error);
    return { valid: false, configFile, error: `${safe.code}: ${safe.message}` };
  }
}
