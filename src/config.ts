import { lstat, readFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { orchestrationPaths } from "./paths.js";

const execFile = promisify(execFileCallback);

export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024;
export interface BridgeConfig { host: "127.0.0.1"; port: number; tokenFile: string; maxInputBytes: number; }
export interface ConfigDiagnostic { valid: boolean; configFile: string; host?: string; port?: number; tokenFile?: string; maxInputBytes?: number; error?: string; }
export class ConfigError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ConfigError"; } }

export function configFilePath(testRoot?: string): string { return orchestrationPaths(process.env, testRoot).bridgeConfig; }
function fileErrorCode(error: unknown): string { const code = (error as NodeJS.ErrnoException | undefined)?.code; return typeof code === "string" && /^E[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""; }
function safeConfigError(error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  if (error instanceof SyntaxError) return new ConfigError("config_invalid", "Configuration must contain valid JSON");
  return new ConfigError("config_unreadable", `Configuration could not be read${fileErrorCode(error)}; check filesystem availability and permissions`);
}

export async function loadConfig(testRoot?: string): Promise<BridgeConfig> {
  const path = configFilePath(testRoot); let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("config_missing", `Configuration file not found: ${path}`); throw safeConfigError(error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config_invalid", "Configuration must be a JSON object");
  const raw = value as Record<string, unknown>; const port = raw.port; const token = raw.token_file; const maxInputBytes = raw.max_input_bytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (raw.host !== "127.0.0.1") throw new ConfigError("config_non_loopback", "host must be 127.0.0.1");
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new ConfigError("config_port_invalid", "port must be an integer from 1 through 65535");
  if (typeof token !== "string" || !token.trim()) throw new ConfigError("config_token_invalid", "token_file must be a non-empty path");
  if (!Number.isInteger(maxInputBytes) || (maxInputBytes as number) < 1024 || (maxInputBytes as number) > DEFAULT_MAX_INPUT_BYTES) throw new ConfigError("config_input_limit_invalid", "max_input_bytes must be between 1024 and 16384");
  const tokenFile = isAbsolute(token) ? resolve(token) : resolve(dirname(path), token);
  const root = resolve(orchestrationPaths(process.env, testRoot).root); const outside = relative(root, tokenFile);
  if (!outside || isAbsolute(outside) || outside === ".." || outside.startsWith(".." + sep)) throw new ConfigError("config_token_outside_root", "token_file must remain inside the private orchestration root");
  await verifyTokenFile(tokenFile);
  return { host: "127.0.0.1", port: port as number, tokenFile, maxInputBytes: maxInputBytes as number };
}
function psQuote(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
async function verifyWindowsTokenAcl(tokenFile: string): Promise<void> {
  if (process.platform !== "win32") return;
  const script = [
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$acl = (New-Object System.IO.FileInfo(" + psQuote(tokenFile) + ")).GetAccessControl()",
    "$ownerSid = $acl.Owner",
    "try { $ownerSid = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}",
    "if ($ownerSid -ne $sid) { exit 79 }",
    "$rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])",
    // Atomic token creation inherits the private current-user ACE from the
    // protected config directory. Inheritance is safe only when that ACE is
    // still scoped to the current SID; reject every other identity regardless
    // of whether its ACE is explicit or inherited.
    "$bad = @($rules | Where-Object { $_.IdentityReference.Value -ne $sid })",
    "if ($bad.Count -gt 0) { exit 80 }",
    "[Console]::WriteLine('ok')"
  ].join("; ");
  try {
    const result = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 65_536 });
    if (!String(result.stdout).includes("ok")) throw new Error("acl verification did not complete");
  } catch {
    throw new ConfigError("config_token_permissions", "token_file ACL must be private to the current Windows user");
  }
}
async function verifyTokenFile(tokenFile: string): Promise<void> {
  let details; try { details = await lstat(tokenFile); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigError("config_token_missing", "token_file does not exist"); throw new ConfigError("config_token_unreadable", `token_file could not be inspected${fileErrorCode(error)}`); }
  if (!details.isFile()) throw new ConfigError("config_token_invalid", "token_file must be a regular file");
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new ConfigError("config_token_permissions", "token_file permissions must be private to the current user");
  await verifyWindowsTokenAcl(tokenFile);
}
export async function readToken(config: BridgeConfig): Promise<string> { try { const token = (await readFile(config.tokenFile, "utf8")).trim(); if (!token) throw new ConfigError("config_token_empty", "token_file is empty"); return token; } catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError("config_token_unreadable", `token_file could not be read${fileErrorCode(error)}`); } }
export async function validateConfig(testRoot?: string): Promise<ConfigDiagnostic> { const configFile = configFilePath(testRoot); try { const config = await loadConfig(testRoot); return { valid: true, configFile, host: config.host, port: config.port, tokenFile: config.tokenFile, maxInputBytes: config.maxInputBytes }; } catch (error) { const safe = safeConfigError(error); return { valid: false, configFile, error: `${safe.code}: ${safe.message}` }; } }
