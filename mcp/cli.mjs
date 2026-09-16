// src/cli.ts
import { readFile as readFile4 } from "node:fs/promises";
import { resolve as resolve5 } from "node:path";
import { fileURLToPath } from "node:url";

// src/client.ts
import { createHmac } from "node:crypto";

// src/config.ts
import { lstat, readFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { dirname, isAbsolute as isAbsolute2, relative, resolve as resolve2, sep } from "node:path";
import { promisify } from "node:util";

// src/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
function orchestrationPaths(env = process.env, testRoot) {
  const localAppData = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE?.trim() || homedir(), "AppData", "Local");
  const root = resolve(testRoot || join(localAppData, "CodexOrchestration"));
  const config = join(root, "config");
  const state = join(root, "state");
  return {
    root,
    releases: join(root, "releases"),
    config,
    state,
    logs: join(root, "logs"),
    workspaces: join(root, "workspaces"),
    current: join(root, "current"),
    previous: join(root, "previous"),
    token: join(config, "token"),
    controllerEnvironment: join(config, "controller-env.json"),
    bridgeConfig: join(config, "config.json"),
    launcher: join(root, "run-orchestration.cmd"),
    runner: join(root, "run-orchestration.ps1"),
    taskXml: join(root, "task.xml"),
    metadata: join(root, "installation.json"),
    mutex: join(state, "lifecycle.lock")
  };
}

// src/config.ts
var execFile = promisify(execFileCallback);
var DEFAULT_MAX_INPUT_BYTES = 16 * 1024;
var ConfigError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ConfigError";
  }
  code;
};
function configFilePath(testRoot) {
  return orchestrationPaths(process.env, testRoot).bridgeConfig;
}
function fileErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^E[A-Z0-9_]+$/.test(code) ? ` (${code})` : "";
}
function safeConfigError(error) {
  if (error instanceof ConfigError) return error;
  if (error instanceof SyntaxError) return new ConfigError("config_invalid", "Configuration must contain valid JSON");
  return new ConfigError("config_unreadable", `Configuration could not be read${fileErrorCode(error)}; check filesystem availability and permissions`);
}
async function loadConfig(testRoot) {
  const path = configFilePath(testRoot);
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new ConfigError("config_missing", `Configuration file not found: ${path}`);
    throw safeConfigError(error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("config_invalid", "Configuration must be a JSON object");
  const raw = value;
  const port = raw.port;
  const token = raw.token_file;
  const maxInputBytes = raw.max_input_bytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (raw.host !== "127.0.0.1") throw new ConfigError("config_non_loopback", "host must be 127.0.0.1");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("config_port_invalid", "port must be an integer from 1 through 65535");
  if (typeof token !== "string" || !token.trim()) throw new ConfigError("config_token_invalid", "token_file must be a non-empty path");
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1024 || maxInputBytes > DEFAULT_MAX_INPUT_BYTES) throw new ConfigError("config_input_limit_invalid", "max_input_bytes must be between 1024 and 16384");
  const tokenFile = isAbsolute2(token) ? resolve2(token) : resolve2(dirname(path), token);
  const root = resolve2(orchestrationPaths(process.env, testRoot).root);
  const outside = relative(root, tokenFile);
  if (!outside || isAbsolute2(outside) || outside === ".." || outside.startsWith(".." + sep)) throw new ConfigError("config_token_outside_root", "token_file must remain inside the private orchestration root");
  await verifyTokenFile(tokenFile);
  return { host: "127.0.0.1", port, tokenFile, maxInputBytes };
}
function psQuote(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
async function verifyWindowsTokenAcl(tokenFile) {
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
    const result = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 65536 });
    if (!String(result.stdout).includes("ok")) throw new Error("acl verification did not complete");
  } catch {
    throw new ConfigError("config_token_permissions", "token_file ACL must be private to the current Windows user");
  }
}
async function verifyTokenFile(tokenFile) {
  let details;
  try {
    details = await lstat(tokenFile);
  } catch (error) {
    if (error.code === "ENOENT") throw new ConfigError("config_token_missing", "token_file does not exist");
    throw new ConfigError("config_token_unreadable", `token_file could not be inspected${fileErrorCode(error)}`);
  }
  if (!details.isFile()) throw new ConfigError("config_token_invalid", "token_file must be a regular file");
  if (process.platform !== "win32" && (details.mode & 63) !== 0) throw new ConfigError("config_token_permissions", "token_file permissions must be private to the current user");
  await verifyWindowsTokenAcl(tokenFile);
}
async function readToken(config) {
  try {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!token) throw new ConfigError("config_token_empty", "token_file is empty");
    return token;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config_token_unreadable", `token_file could not be read${fileErrorCode(error)}`);
  }
}
async function validateConfig(testRoot) {
  const configFile = configFilePath(testRoot);
  try {
    const config = await loadConfig(testRoot);
    return { valid: true, configFile, host: config.host, port: config.port, tokenFile: config.tokenFile, maxInputBytes: config.maxInputBytes };
  } catch (error) {
    const safe = safeConfigError(error);
    return { valid: false, configFile, error: `${safe.code}: ${safe.message}` };
  }
}

// src/client.ts
var BridgeError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
};
var CONTROL_OPERATIONS = /* @__PURE__ */ new Set([
  "bind_project",
  "enroll",
  "register_pm",
  "claim",
  "revise",
  "pause",
  "resume",
  "interrupt",
  "cancel",
  "review",
  "handoff",
  "operator_takeover"
]);
var MAX_RESPONSE_BYTES = 1048576;
var PM_CREDENTIAL_CONTEXT = "codex-orchestration-pm-v1:";
function derivePmCredential(operatorToken, threadId) {
  const digest = createHmac("sha256", operatorToken).update(`${PM_CREDENTIAL_CONTEXT}${threadId}`, "utf8").digest("hex");
  return `pm-v1.${threadId}.${digest}`;
}
function endpointHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
function safeMessage(status, body, token) {
  if (status === 401 || status === 403) return "Symphony rejected the bridge credentials";
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    const code = error && typeof error === "object" && "code" in error ? error.code : void 0;
    if (typeof code === "string" && /^[a-z0-9_:-]{1,80}$/.test(code) && !code.includes(token)) {
      return `Symphony request failed: ${code}`;
    }
  }
  return `Symphony request failed with HTTP ${status}`;
}
var MANAGED_STATE_VIEWS = /* @__PURE__ */ new Set(["summary", "detail", "full"]);
function stateQuery(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new BridgeError("state_args_invalid", "state arguments must be an object");
  }
  if (args.view !== void 0 && (typeof args.view !== "string" || !MANAGED_STATE_VIEWS.has(args.view))) {
    throw new BridgeError("state_view_invalid", "view must be summary, detail, or full");
  }
  for (const [name, value] of [["project_id", args.project_id], ["assignment_id", args.assignment_id]]) {
    if (value !== void 0 && (typeof value !== "string" || value.trim() === "")) {
      throw new BridgeError("state_filter_invalid", `${name} must be a non-empty string`);
    }
  }
  if (args.include_history !== void 0 && typeof args.include_history !== "boolean") {
    throw new BridgeError("state_history_invalid", "include_history must be a boolean");
  }
  if (args.view === "detail" && args.assignment_id === void 0) {
    throw new BridgeError("state_assignment_required", "detail state requires assignment_id");
  }
  const query = new URLSearchParams();
  if (args.view !== void 0) query.set("view", args.view);
  if (args.project_id !== void 0) query.set("project_id", args.project_id);
  if (args.assignment_id !== void 0) query.set("assignment_id", args.assignment_id);
  if (args.include_history !== void 0) query.set("include_history", String(args.include_history));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
var ManagedClient = class _ManagedClient {
  constructor(config, operatorToken, trustedThreadId) {
    this.config = config;
    this.trustedThreadId = trustedThreadId;
    this.authorizationToken = trustedThreadId ? derivePmCredential(operatorToken, trustedThreadId) : operatorToken;
  }
  config;
  trustedThreadId;
  authorizationToken;
  static async fromConfig(trustedThreadId, testRoot) {
    const config = await loadConfig(testRoot);
    return new _ManagedClient(config, await readToken(config), trustedThreadId);
  }
  async state(args = {}, timeoutMs = 6e4) {
    const query = stateQuery(args);
    return this.request(`/api/v1/managed/state${query}`, { method: "GET" }, false, timeoutMs);
  }
  async events(after, waitMs, limit) {
    if (!Number.isInteger(after) || after < 0) throw new BridgeError("events_after_invalid", "after must be a non-negative integer");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 6e4) throw new BridgeError("events_wait_invalid", "wait_ms must be between 0 and 60000");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BridgeError("events_limit_invalid", "limit must be between 1 and 100");
    return this.request(`/api/v1/managed/events?after=${after}&wait_ms=${waitMs}&limit=${limit}`, { method: "GET" });
  }
  async control(request) {
    if (!request || typeof request.request_id !== "string" || request.request_id.trim() === "") {
      throw new BridgeError("request_id_invalid", "request_id must be a non-empty string");
    }
    if (!request || typeof request.operation !== "string" || !CONTROL_OPERATIONS.has(request.operation)) {
      throw new BridgeError("operation_invalid", "operation is not supported");
    }
    if (!request.args || typeof request.args !== "object" || Array.isArray(request.args)) {
      throw new BridgeError("args_invalid", "args must be an object");
    }
    return this.request("/api/v1/managed/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    }, true);
  }
  async request(path, init, mutation = false, timeoutMs = 6e4) {
    const bodyBytes = init.body ? Buffer.byteLength(String(init.body), "utf8") : 0;
    if (bodyBytes > this.config.maxInputBytes) throw new BridgeError("request_too_large", "request exceeds configured input limit");
    let response;
    try {
      response = await fetch(`http://${endpointHost(this.config.host)}:${this.config.port}${path}`, {
        ...init,
        headers: { ...init.headers ?? {}, authorization: `Bearer ${this.authorizationToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, timeoutMs))
      });
    } catch {
      throw new BridgeError(mutation ? "mutation_outcome_uncertain" : "upstream_unreachable", mutation ? "The mutation may have reached Symphony; inspect state using the same request_id before retrying" : "Symphony loopback service is unavailable");
    }
    let parsed = null;
    try {
      const reader = response.body?.getReader();
      if (!reader) {
        parsed = null;
      } else {
        const chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => void 0);
              throw new BridgeError(mutation ? "mutation_outcome_uncertain" : "upstream_response_too_large", mutation ? "The mutation response could not be bounded safely; inspect state using the same request_id before retrying" : "Symphony response exceeds the bridge limit", response.status);
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
      if (error instanceof BridgeError) {
        if (mutation && error.code !== "mutation_outcome_uncertain" && response.ok) {
          throw new BridgeError("mutation_outcome_uncertain", "The mutation response could not be understood; inspect state using the same request_id before retrying", response.status);
        }
        throw error;
      }
      if (mutation) throw new BridgeError("mutation_outcome_uncertain", "The mutation response could not be understood; inspect state using the same request_id before retrying", response.status);
      throw new BridgeError("upstream_invalid_response", response.ok ? "Symphony returned invalid JSON" : `Symphony request failed with HTTP ${response.status}`, response.status);
    }
    if (mutation && response.ok && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new BridgeError("mutation_outcome_uncertain", "The mutation response could not be understood; inspect state using the same request_id before retrying", response.status);
    if (!response.ok) throw new BridgeError("upstream_error", safeMessage(response.status, parsed, this.authorizationToken), response.status);
    return parsed;
  }
};

// src/lifecycle.ts
import { lstat as lstat2, mkdir, open, readFile as readFile2, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as execFileCallback2 } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { dirname as dirname2, extname, isAbsolute as isAbsolute3, join as join2, resolve as resolve3 } from "node:path";
import { promisify as promisify2 } from "node:util";
var execFile2 = promisify2(execFileCallback2);
var DEFAULT_PORT = 8787;
var RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var TASK_NAME = "CodexOrchestration";
var READY_TIMEOUT_MS = 6e4;
var CONTROLLER_ENV_NAME = /^(?:GITHUB_TOKEN|GH_TOKEN|GITHUB_APP_ID|GITHUB_APP_INSTALLATION_ID|GITHUB_APP_PRIVATE_KEY|GITHUB_API_URL|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|API_KEY|API_TOKEN|CLIENT_ID|CLIENT_SECRET|PRIVATE_KEY))$/i;
var CONTROLLER_IDENTITY_NAME = /(?:^|_)(?:thread|task|assignment|conversation|pm|owner|identity|symphony)(?:_|$)/i;
var LifecycleError = class extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "LifecycleError";
  }
  code;
  status;
};
function paths(options = {}) {
  const base = orchestrationPaths();
  return { ...base, taskName: TASK_NAME, workflow: join2(base.config, "WORKFLOW.md") };
}
async function run(command2, args, allowFailure = false) {
  try {
    const value = await execFile2(command2, args, { windowsHide: true, maxBuffer: 1048576 });
    return { stdout: value.stdout, stderr: value.stderr, code: 0 };
  } catch (cause) {
    const value = cause;
    if (allowFailure) return { stdout: value.stdout || "", stderr: value.stderr || "", code: typeof value.code === "number" ? value.code : 1 };
    const output = String(value.stderr || value.stdout || "").trim().slice(0, 500);
    throw new LifecycleError("command_failed", command2 + " " + args.join(" ") + " failed" + (output ? ": " + output : ""), value.code);
  }
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true });
  if (process.platform !== "win32") return;
  const sid = await currentSid();
  const aclOk = (result) => result.code === 0 && !/Failed processing\s+[1-9]/i.test(result.stdout + result.stderr);
  const reset = await run("icacls.exe", [path, "/reset", "/t", "/c"], true);
  if (!aclOk(reset)) throw new LifecycleError("acl_failed", "could not reset orchestration state ACLs");
  const bootstrap = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":F", "/t", "/c"], true);
  if (!aclOk(bootstrap)) throw new LifecycleError("acl_failed", "could not bootstrap private orchestration ACLs");
  const inheritance = await run("icacls.exe", [path, "/inheritance:r", "/t", "/c"], true);
  if (!aclOk(inheritance)) throw new LifecycleError("acl_failed", "could not remove inherited orchestration state ACLs");
  const acl = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":F", "/t", "/c"], true);
  if (!aclOk(acl)) throw new LifecycleError("acl_failed", "could not protect private orchestration state with the current user ACL");
  const childAcl = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":(OI)(CI)F"], true);
  if (!aclOk(childAcl)) throw new LifecycleError("acl_failed", "could not configure private orchestration child ACL inheritance");
  const owner = await run("icacls.exe", [path, "/setowner", "*" + sid, "/t", "/c"], true);
  if (!aclOk(owner)) throw new LifecycleError("acl_failed", "could not set the private orchestration state owner");
}
async function atomic(path, body) {
  await privateDirectory(dirname2(path));
  const temporary = path + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
  await writeFile(temporary, body, { mode: 384 });
  await rename(temporary, path);
}
async function optional(path) {
  try {
    return (await readFile2(path, "utf8")).trim() || void 0;
  } catch (cause) {
    if (cause.code === "ENOENT") return void 0;
    throw new LifecycleError("read_failed", "could not read " + path);
  }
}
function releaseVersion(input) {
  const value = input?.trim() || "local-" + Date.now();
  if (!RELEASE_PATTERN.test(value)) throw new LifecycleError("version_invalid", "version must contain only letters, numbers, dots, underscores, and hyphens");
  return value;
}
function validateReleaseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("release_manifest_invalid", "release manifest must be an object");
  const raw = value;
  if (raw.repository !== "iharc-jordan/symphony" || raw.version !== "0.4.0") throw new LifecycleError("release_manifest_invalid", "release manifest must identify iharc-jordan/symphony version 0.4.0");
  if (typeof raw.runtimeDownloadUrl !== "string" || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(raw.sha256)) throw new LifecycleError("release_manifest_invalid", "release manifest requires runtimeDownloadUrl and a SHA-256 digest");
  if (raw.distribution !== "none" || raw.cookieFile !== "absent") throw new LifecycleError("release_manifest_invalid", "release manifest must disable Erlang distribution and omit the cookie file");
  let url;
  try {
    url = new URL(raw.runtimeDownloadUrl);
  } catch {
    throw new LifecycleError("release_manifest_invalid", "runtimeDownloadUrl must be an HTTPS GitHub release URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/iharc-jordan/symphony/releases/download/v0.4.0/")) throw new LifecycleError("release_manifest_invalid", "runtimeDownloadUrl must pin the Symphony v0.4.0 GitHub release");
  return { repository: "iharc-jordan/symphony", version: "0.4.0", runtimeDownloadUrl: url.toString(), sha256: raw.sha256.toLowerCase(), distribution: "none", cookieFile: "absent" };
}
function absolute(input, label) {
  if (!isAbsolute3(input)) throw new LifecycleError(label + "_invalid", label + " must be an absolute Windows path");
  return resolve3(input);
}
async function regularFile(input, label) {
  const path = absolute(input, label);
  try {
    const detail = await stat(path);
    if (!detail.isFile()) throw new Error("not-file");
    const handle = await open(path, constants.R_OK);
    await handle.close();
  } catch {
    throw new LifecycleError(label + "_invalid", label + " is not a readable regular file: " + path);
  }
  return path;
}
async function resolveCodexLauncher(override) {
  const appData = process.env.APPDATA?.trim();
  const candidate = override?.trim() || (appData ? join2(appData, "npm", "codex.cmd") : "");
  if (!candidate) throw new LifecycleError("launcher_missing", "codex.cmd was not found at the public npm path; pass --launcher with an absolute path");
  return regularFile(candidate, "launcher");
}
function launcherContent(p, port) {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + p.runner + '"',
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
}
function psQuote2(value) {
  return "'" + value.replaceAll("'", "''") + "'";
}
function runnerContent(p, _port) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$controllerEnv = [pscustomobject]@{}",
    "if (Test-Path -LiteralPath " + psQuote2(p.controllerEnvironment) + " -PathType Leaf) { $controllerEnv = Get-Content -Raw -LiteralPath " + psQuote2(p.controllerEnvironment) + " | ConvertFrom-Json }",
    "$blocked = '(?i)(^|_)(thread|task|assignment|conversation|pm|owner|identity|symphony)(_|$)'",
    "Get-ChildItem Env: | ForEach-Object { if ($_.Name -match $blocked -and -not ($controllerEnv.psobject.Properties.Name -contains $_.Name)) { Remove-Item -LiteralPath ('Env:' + $_.Name) } }",
    "$controllerEnv.psobject.Properties | ForEach-Object { if ($_.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $_.Name -match $blocked -or $null -eq $_.Value) { throw 'invalid controller environment' }; Set-Item -LiteralPath ('Env:' + $_.Name) -Value ([string]$_.Value) }",
    "$bridge = Get-Content -Raw -LiteralPath " + psQuote2(p.bridgeConfig) + " | ConvertFrom-Json",
    "$port = [int]$bridge.port",
    "if ([string]$bridge.host -ne '127.0.0.1' -or $port -lt 1 -or $port -gt 65535) { exit 78 }",
    "$bridgeTokenRaw = [string]$bridge.token_file",
    "$bridgeToken = if ([IO.Path]::IsPathRooted($bridgeTokenRaw)) { [IO.Path]::GetFullPath($bridgeTokenRaw) } else { [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent " + psQuote2(p.bridgeConfig) + ") $bridgeTokenRaw)) }",
    "if ($bridgeToken -ne [IO.Path]::GetFullPath(" + psQuote2(p.token) + ")) { exit 78 }",
    "$release = (Get-Content -Raw -LiteralPath " + psQuote2(p.current) + ").Trim()",
    "if ($release -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { exit 78 }",
    "$releaseRoot = Join-Path " + psQuote2(p.releases) + " $release",
    "$entry = Join-Path $releaseRoot 'bin\\symphony.bat'",
    "if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { exit 78 }",
    "$env:SYMPHONY_WINDOWS_WORKER_HOST = Join-Path (Split-Path -Parent $entry) 'symphony-worker-host.exe'",
    "if (-not (Test-Path -LiteralPath $env:SYMPHONY_WINDOWS_WORKER_HOST -PathType Leaf)) { exit 78 }",
    "$env:SYMPHONY_WORKFLOW_PATH = " + psQuote2(p.workflow),
    "$env:SYMPHONY_LOGS_ROOT = " + psQuote2(p.logs),
    "$env:SYMPHONY_STATE_ROOT = " + psQuote2(p.state),
    "$env:SYMPHONY_WORKSPACES_ROOT = " + psQuote2(p.workspaces),
    "$env:SYMPHONY_CONTROL_TOKEN_FILE = $bridgeToken",
    "$env:SYMPHONY_SERVER_HOST = '127.0.0.1'",
    "$env:SYMPHONY_SERVER_PORT = [string]$port",
    "$env:SYMPHONY_MANAGED = 'true'",
    "$env:RELEASE_DISTRIBUTION = 'none'",
    "$env:RELEASE_COOKIE = 'codex_orchestration_local_only'",
    "$controllerIdentity = Join-Path " + psQuote2(p.state) + " 'controller-process.json'",
    `$controllerCommand = '""' + $entry + '" start"'`,
    "$controllerArgs = @('--parent-pid', [string]$PID, '--job-name', 'CodexOrchestrationController', '--identity-file', $controllerIdentity, '--cwd', $releaseRoot, '--attempt-id', 'controller', '--', $env:ComSpec, '/d', '/s', '/c', $controllerCommand)",
    "& $env:SYMPHONY_WINDOWS_WORKER_HOST @controllerArgs",
    "exit $LASTEXITCODE",
    ""
  ].join("\r\n");
}
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function scheduledTaskXml(p, userSid) {
  const args = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + p.runner + '"';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>Codex Orchestration native Windows service</Description></RegistrationInfo>",
    "  <Triggers><LogonTrigger><UserId>" + escapeXml(userSid) + "</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>",
    '  <Principals><Principal id="Author"><UserId>' + escapeXml(userSid) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "  <Settings><Hidden>true</Hidden><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>",
    '  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>' + escapeXml(args) + "</Arguments></Exec></Actions>",
    "</Task>",
    ""
  ].join("\r\n");
}
async function currentSid() {
  const identity = await run("whoami.exe", ["/user"]);
  const sid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  return sid;
}
async function taskSnapshot(p) {
  const script = "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq " + psQuote2(p.taskName) + ` -and $_.TaskPath -eq '\\' }); if ($tasks.Count -eq 0) { [Console]::WriteLine('{"exists":false,"running":false,"active":false}'); exit 0 }; $state = [int]$tasks[0].State; [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ exists = $true; running = ($state -eq 4); active = ($state -eq 2 -or $state -eq 4) }))`;
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], true);
  if (result.code !== 0) throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task");
  try {
    const value = JSON.parse(result.stdout.trim());
    if (typeof value.exists !== "boolean" || typeof value.running !== "boolean" || typeof value.active !== "boolean") throw new Error("invalid");
    return { exists: value.exists, running: value.running, active: value.active };
  } catch {
    throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task");
  }
}
async function taskExists(p) {
  return (await taskSnapshot(p)).exists;
}
async function taskDiagnostics(p) {
  const taskName = psQuote2(p.taskName);
  const script = [
    "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq " + taskName + " -and $_.TaskPath -eq '\\' })",
    `if ($tasks.Count -eq 0) { [Console]::WriteLine('{"exists":false,"running":false,"active":false}'); exit 0 }`,
    "$task = $tasks[0]",
    "$state = [int]$task.State",
    "$info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction Stop",
    "$lastRun = if ($null -eq $info.LastRunTime) { $null } else { ([datetime]$info.LastRunTime).ToString('o') }",
    "$nextRun = if ($null -eq $info.NextRunTime) { $null } else { ([datetime]$info.NextRunTime).ToString('o') }",
    "$action = @($task.Actions)[0]",
    "$hidden = [bool]$task.Settings.Hidden",
    "$command = [string]$action.Execute",
    "$taskArgs = [string]$action.Arguments",
    "$sensitive = '(?i)(token|secret|password|authorization|cookie|credential|api[-_]?key|private[-_]?key|bearer)'",
    "$safeCommand = if ($command -match $sensitive) { '<redacted>' } else { $command }",
    "$safeArgs = if ($taskArgs -match $sensitive) { '<redacted>' } else { $taskArgs }",
    "[Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ exists = $true; state = $state; running = ($state -eq 4); active = ($state -eq 2 -or $state -eq 4); lastTaskResult = [int64]$info.LastTaskResult; lastRunTime = $lastRun; nextRunTime = $nextRun; action = @{ command = $safeCommand; arguments = $safeArgs; hidden = $hidden } }))"
  ].join("; ");
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], true);
  if (result.code !== 0) throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task");
  try {
    const value = JSON.parse(result.stdout.trim());
    if (typeof value.exists !== "boolean" || typeof value.running !== "boolean" || typeof value.active !== "boolean") throw new Error("invalid");
    if (!value.exists) return { exists: false, running: false, active: false };
    if (typeof value.state !== "number") throw new Error("invalid state");
    const action = value.action;
    return {
      exists: true,
      state: value.state,
      running: value.running,
      active: value.active,
      lastTaskResult: typeof value.lastTaskResult === "number" ? value.lastTaskResult : null,
      lastRunTime: typeof value.lastRunTime === "string" ? value.lastRunTime : null,
      nextRunTime: typeof value.nextRunTime === "string" ? value.nextRunTime : null,
      action: action && typeof action.command === "string" && typeof action.arguments === "string" && typeof action.hidden === "boolean" ? { command: action.command, arguments: action.arguments, hidden: action.hidden } : void 0
    };
  } catch {
    throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task");
  }
}
async function releaseEntryDiagnostics(p, label) {
  if (!label || !RELEASE_PATTERN.test(label)) return { label: label || null, valid: false, error: "selected release pointer is missing or invalid" };
  const releaseRoot = join2(p.releases, label);
  const entry = join2(releaseRoot, "bin", "symphony.bat");
  const workerHost = join2(releaseRoot, "bin", "symphony-worker-host.exe");
  const environment = join2(releaseRoot, "releases", label, "env.bat");
  const cookie = join2(releaseRoot, "releases", "COOKIE");
  const isRegular = async (file) => {
    try {
      return (await lstat2(file)).isFile();
    } catch {
      return false;
    }
  };
  const isAbsent = async (file) => {
    try {
      await lstat2(file);
      return false;
    } catch (cause) {
      return cause.code === "ENOENT";
    }
  };
  const entryValid = await isRegular(entry);
  const workerHostValid = await isRegular(workerHost);
  let distributionDisabled = false;
  try {
    distributionDisabled = /^(?:set )?\"?RELEASE_DISTRIBUTION=none\"?\s*$/im.test(await readFile2(environment, "utf8"));
  } catch {
    distributionDisabled = false;
  }
  const cookieAbsent = await isAbsent(cookie);
  const valid = entryValid && workerHostValid && distributionDisabled && cookieAbsent;
  return { label, entry, workerHost, environment, entryValid, workerHostValid, distributionDisabled, cookieAbsent, valid, error: valid ? void 0 : "selected release must contain regular launch entries, disable Erlang distribution, and omit releases\\COOKIE" };
}
async function taskOwned(p) {
  if (!await taskExists(p)) return true;
  const metadata = await optional(p.metadata);
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.taskName !== p.taskName || parsed.root !== p.root) return false;
  } catch {
    return false;
  }
  const task = p.taskName.replaceAll("'", "''");
  const exported = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Export-ScheduledTask -TaskName '" + task + "' | Out-String"], true);
  return exported.code === 0 && exported.stdout.includes("Codex Orchestration native Windows service") && exported.stdout.replaceAll("&quot;", "").includes(p.runner);
}
async function installTask(p, port) {
  if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
  await atomic(p.launcher, launcherContent(p, port));
  await atomic(p.runner, runnerContent(p, port));
  await atomic(p.taskXml, Buffer.from("\uFEFF" + scheduledTaskXml(p, await currentSid()), "utf16le"));
  await run("schtasks.exe", ["/Create", "/TN", p.taskName, "/XML", p.taskXml, "/F"]);
}
async function taskRunning(p) {
  return (await taskSnapshot(p)).running;
}
async function stopRecordedController(p) {
  const identityPath = join2(p.state, "controller-process.json");
  const identityRaw = await optional(identityPath);
  if (!identityRaw) return;
  const release = await optional(p.current);
  if (!release || !RELEASE_PATTERN.test(release)) throw new LifecycleError("controller_identity_invalid", "controller identity exists without a valid selected release");
  const helper = await regularFile(join2(p.releases, release, "bin", "symphony-worker-host.exe"), "worker_host");
  let identity;
  try {
    identity = JSON.parse(identityRaw);
  } catch {
    throw new LifecycleError("controller_identity_invalid", "controller process identity is not valid JSON");
  }
  const creationMatches = Array.from(identityRaw.matchAll(/"child_creation_time"\s*:\s*(\d+)/g));
  const pid = identity.child_pid;
  if (identity.version !== 1 || identity.job_name !== "CodexOrchestrationController" || identity.attempt_id !== "controller" || !Number.isInteger(pid) || Number(pid) < 1 || Number(pid) > 4294967295 || creationMatches.length !== 1) {
    throw new LifecycleError("controller_identity_invalid", "controller process identity is invalid");
  }
  const args = ["--stop", "--job-name", "CodexOrchestrationController", "--pid", String(pid), "--creation-time", creationMatches[0][1]];
  let stopped = await run(helper, args, true);
  if (stopped.code !== 0) {
    await new Promise((done) => setTimeout(done, 250));
    stopped = await run(helper, args, true);
  }
  if (stopped.code !== 0) throw new LifecycleError("controller_stop_failed", "could not verify termination of the owned controller Job");
  await rm(identityPath, { force: true });
}
async function stopTask(p) {
  const before = await taskSnapshot(p);
  await stopRecordedController(p);
  if (!before.exists) return;
  const afterControllerStop = await taskSnapshot(p);
  if (afterControllerStop.active) {
    const ended = await run("schtasks.exe", ["/End", "/TN", p.taskName], true);
    if (ended.code !== 0) throw new LifecycleError("task_stop_failed", "could not stop the orchestration scheduled task");
  }
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    if (!(await taskSnapshot(p)).active) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new LifecycleError("task_stop_failed", "orchestration scheduled task did not stop before the release switch");
}
async function stopOwnedTask(p) {
  if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
  await stopTask(p);
}
async function readReleaseManifest(path) {
  try {
    return validateReleaseManifest(JSON.parse(await readFile2(await regularFile(path, "release_manifest"), "utf8")));
  } catch (cause) {
    if (cause instanceof LifecycleError) throw cause;
    throw new LifecycleError("release_manifest_invalid", "release manifest is not valid JSON");
  }
}
function sha256(value) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new LifecycleError("sha256_invalid", "a 64-character SHA-256 digest is required for a release ZIP");
  return value.toLowerCase();
}
async function verifiedReleaseSource(p, options) {
  const manifest = options.releaseManifest ? await readReleaseManifest(options.releaseManifest) : void 0;
  const requestedSha = options.sha256 ? sha256(options.sha256) : void 0;
  if (manifest && requestedSha && requestedSha !== manifest.sha256) throw new LifecycleError("release_hash_mismatch", "offline SHA-256 does not match the pinned release manifest");
  const expected = manifest?.sha256 || requestedSha;
  if (!expected) throw new LifecycleError("sha256_invalid", "a 64-character SHA-256 digest is required for a release ZIP");
  let source;
  let downloaded = false;
  if (options.executable) source = await regularFile(options.executable, "release");
  else {
    if (!manifest) throw new LifecycleError("release_source_required", "provide --release-manifest or an offline --executable ZIP with --sha256");
    source = join2(p.state, "download-" + randomBytes(8).toString("hex") + ".zip");
    downloaded = true;
    let response;
    try {
      response = await fetch(manifest.runtimeDownloadUrl, { redirect: "follow", signal: AbortSignal.timeout(remainingDeadline(options.deadlineAt, 6e4)) });
    } catch {
      throw new LifecycleError("release_download_failed", "could not download the pinned Symphony release ZIP");
    }
    let finalUrl;
    try {
      finalUrl = new URL(response.url || manifest.runtimeDownloadUrl);
    } catch {
      throw new LifecycleError("release_download_failed", "pinned Symphony release URL was invalid");
    }
    const githubReleaseHosts = /* @__PURE__ */ new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
    if (finalUrl.protocol !== "https:" || !githubReleaseHosts.has(finalUrl.hostname.toLowerCase())) throw new LifecycleError("release_download_failed", "pinned Symphony release redirected outside GitHub");
    if (finalUrl.hostname.toLowerCase() === "github.com" && !finalUrl.pathname.startsWith("/iharc-jordan/symphony/releases/download/v0.4.0/")) throw new LifecycleError("release_download_failed", "pinned Symphony release redirected to an unapproved GitHub path");
    if (!response.ok) throw new LifecycleError("release_download_failed", "could not download the pinned Symphony release ZIP");
    await writeFile(source, Buffer.from(await response.arrayBuffer()), { mode: 384 });
  }
  if (extname(source).toLowerCase() !== ".zip") throw new LifecycleError("release_invalid", "release must be a standard Windows Mix release ZIP");
  const actual = createHash("sha256").update(await readFile2(source)).digest("hex");
  if (actual !== expected) {
    if (downloaded) await rm(source, { force: true });
    throw new LifecycleError("release_hash_mismatch", "release ZIP SHA-256 does not match the pinned expected digest");
  }
  return { path: source, downloaded };
}
async function stageRelease(p, options, release) {
  const input = await verifiedReleaseSource(p, options);
  const source = input.path;
  const root = join2(p.releases, release);
  const target = join2(root, "bin", "symphony.bat");
  const workerHost = join2(root, "bin", "symphony-worker-host.exe");
  const environment = join2(root, "releases", release, "env.bat");
  const cookie = join2(root, "releases", "COOKIE");
  if (extname(source).toLowerCase() !== ".zip") throw new LifecycleError("release_invalid", "release must be a standard Windows Mix release ZIP");
  try {
    await stat(root);
    if (input.downloaded) await rm(source, { force: true });
    throw new LifecycleError("release_exists", "release " + release + " already exists and is immutable");
  } catch (cause) {
    if (cause instanceof LifecycleError) throw cause;
    if (cause.code !== "ENOENT") {
      if (input.downloaded) await rm(source, { force: true });
      throw new LifecycleError("release_invalid", "could not inspect release " + release);
    }
  }
  await privateDirectory(root);
  try {
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath " + psQuote2(source) + " -DestinationPath " + psQuote2(root) + " -ErrorAction Stop"]);
    const targetInfo = await lstat2(target);
    const workerInfo = await lstat2(workerHost);
    const environmentInfo = await lstat2(environment);
    if (!targetInfo.isFile() || !workerInfo.isFile() || !environmentInfo.isFile()) throw new Error("release entries must be files");
    const environmentContents = await readFile2(environment, "utf8");
    if (!/^(?:set )?\"?RELEASE_DISTRIBUTION=none\"?\s*$/im.test(environmentContents)) throw new Error("release distribution must be disabled");
    try {
      await lstat2(cookie);
      throw new Error("release cookie must be absent");
    } catch (cause) {
      if (cause.code !== "ENOENT") throw cause;
    }
  } catch {
    await rm(root, { recursive: true, force: true });
    throw new LifecycleError("release_invalid", "release ZIP must contain bin\\symphony.bat and bin\\symphony-worker-host.exe");
  } finally {
    if (input.downloaded) await rm(source, { force: true });
  }
  const old = await optional(p.current);
  if (old) await atomic(p.previous, old + "\n");
  await atomic(p.current, release + "\n");
}
function configuredWorkflow(content, launcher) {
  const resolvedLauncher = JSON.stringify(absolute(launcher, "launcher"));
  const pieces = content.split(/(\r\n|\n|\r)/);
  const lines = [];
  for (let index = 0; index < pieces.length; index += 2) lines.push({ text: pieces[index], eol: pieces[index + 1] || "" });
  const first = (lines[0]?.text || "").replace(/^\uFEFF/, "").trim();
  const frontmatterEnd = first === "---" ? lines.findIndex((line, index) => index > 0 && (line.text.trim() === "---" || line.text.trim() === "...")) : lines.length;
  const limit = frontmatterEnd >= 0 ? frontmatterEnd : lines.length;
  const codexIndex = lines.findIndex((line, index) => index < limit && /^codex\s*:/.test(line.text));
  if (codexIndex < 0) throw new LifecycleError("workflow_invalid", "workflow must include a codex section");
  const eol = lines[codexIndex].eol || lines.find((line) => line.eol)?.eol || "\r\n";
  const codexMatch = lines[codexIndex].text.match(/^(\s*)codex\s*:\s*(.*)$/);
  const codexIndent = codexMatch[1].length;
  const inline = codexMatch[2].trim();
  if (inline.startsWith("{") && inline.endsWith("}")) {
    const fields = inlineFields(inline.slice(1, -1)).filter((field) => !/^\s*(?:command|args|launcher)\s*:/.test(field));
    lines[codexIndex].text = codexMatch[1] + "codex: { launcher: " + resolvedLauncher + (fields.length ? ", " + fields.join(", ") : "") + " }";
    return lines.map((line) => line.text + line.eol).join("");
  }
  let childIndent = codexIndent + 2;
  let sectionEnd = limit;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) {
      sectionEnd = index;
      break;
    }
    childIndent = indent;
    break;
  }
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) {
      sectionEnd = index;
      break;
    }
  }
  const kept = [{ text: codexMatch[1] + "codex:", eol }, { text: " ".repeat(childIndent) + "launcher: " + resolvedLauncher, eol }];
  let skipIndent;
  for (let index = codexIndex + 1; index < sectionEnd; index += 1) {
    const line = lines[index];
    const text = line.text;
    const trimmed = text.trim();
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (skipIndent !== void 0) {
      if (!trimmed || indent > skipIndent) continue;
      skipIndent = void 0;
    }
    const key = text.match(/^\s*(command|launcher|args)\s*:\s*(.*)$/);
    if (indent === childIndent && key) {
      const value = key[2].trim();
      if (!value || value.startsWith("#") || value.startsWith("|") || value.startsWith(">")) skipIndent = indent;
      continue;
    }
    kept.push(line);
  }
  lines.splice(codexIndex, sectionEnd - codexIndex, ...kept);
  return lines.map((line) => line.text + line.eol).join("");
}
function workflowStatus(content) {
  const pieces = content.split(/(\r\n|\n|\r)/);
  const lines = [];
  for (let index = 0; index < pieces.length; index += 2) lines.push({ text: pieces[index], eol: pieces[index + 1] || "" });
  const first = (lines[0]?.text || "").replace(/^\uFEFF/, "").trim();
  const frontmatterEnd = first === "---" ? lines.findIndex((line, index) => index > 0 && (line.text.trim() === "---" || line.text.trim() === "...")) : lines.length;
  const limit = frontmatterEnd >= 0 ? frontmatterEnd : lines.length;
  const codexIndex = lines.findIndex((line, index) => index < limit && /^codex\s*:/.test(line.text));
  if (codexIndex < 0) return { hasLauncher: false, hasLegacy: false };
  const header = lines[codexIndex].text.match(/^(\s*)codex\s*:\s*(.*)$/);
  const codexIndent = header[1].length;
  const inline = header[2].trim();
  if (inline.startsWith("{") && inline.endsWith("}")) {
    const fields = inlineFields(inline.slice(1, -1));
    return { hasLauncher: fields.some((field) => /^launcher\s*:/i.test(field)), hasLegacy: fields.some((field) => /^(?:command|args)\s*:/i.test(field)) };
  }
  let childIndent;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) break;
    childIndent = indent;
    break;
  }
  if (childIndent === void 0) return { hasLauncher: false, hasLegacy: false };
  let hasLauncher = false;
  let hasLegacy = false;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text;
    if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) break;
    if (indent !== childIndent) continue;
    const key = text.match(/^\s*(command|launcher|args)\s*:/i)?.[1]?.toLowerCase();
    if (key === "launcher") hasLauncher = true;
    if (key === "command" || key === "args") hasLegacy = true;
  }
  return { hasLauncher, hasLegacy };
}
function inlineFields(value) {
  const fields = [];
  let start2 = 0;
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      fields.push(value.slice(start2, index).trim());
      start2 = index + 1;
    }
  }
  const final = value.slice(start2).trim();
  if (final) fields.push(final);
  return fields;
}
async function stageWorkflow(p, source, launcher) {
  let content;
  if (source) content = await readFile2(await regularFile(source, "workflow"), "utf8");
  else {
    const current = await optional(p.workflow);
    if (current === void 0) throw new LifecycleError("workflow_missing", "setup requires --workflow for the first install");
    content = current;
  }
  await atomic(p.workflow, configuredWorkflow(content, launcher));
}
async function writeConfiguration(p, options) {
  let port = options.port;
  let existingConfig = {};
  if (port === void 0) {
    const current = await optional(p.bridgeConfig);
    if (current) {
      try {
        const parsed = JSON.parse(current);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        existingConfig = parsed;
        port = Number(existingConfig.port);
      } catch {
        throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON");
      }
    }
  } else {
    const current = await optional(p.bridgeConfig);
    if (current) {
      try {
        const parsed = JSON.parse(current);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        existingConfig = parsed;
      } catch {
        throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON");
      }
    }
  }
  port ??= DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LifecycleError("port_invalid", "port must be an integer from 1 through 65535");
  if (!await optional(p.token)) {
    const token = options.tokenFile ? (await readFile2(await regularFile(options.tokenFile, "token_file"), "utf8")).trim() : randomBytes(32).toString("hex");
    if (!token) throw new LifecycleError("token_invalid", "token file is empty");
    await atomic(p.token, token + "\n");
  }
  await atomic(p.bridgeConfig, JSON.stringify({ ...existingConfig, host: "127.0.0.1", port, token_file: p.token, max_input_bytes: 16 * 1024 }, null, 2) + "\n");
  return port;
}
async function writeControllerEnvironment(p) {
  const isAllowed = (name) => CONTROLLER_ENV_NAME.test(name) && !CONTROLLER_IDENTITY_NAME.test(name);
  const captured = captureControllerEnvironment(process.env);
  const saved = {};
  const existing = await optional(p.controllerEnvironment);
  if (existing) {
    try {
      const value = JSON.parse(existing);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid controller environment");
      for (const [name, entry] of Object.entries(value)) {
        if (isAllowed(name) && typeof entry === "string") saved[name] = entry;
      }
    } catch {
      throw new LifecycleError("controller_environment_invalid", "private controller environment is not valid JSON");
    }
  }
  Object.assign(saved, captured);
  await atomic(p.controllerEnvironment, JSON.stringify(saved, null, 2) + "\n");
}
function captureControllerEnvironment(input) {
  const isAllowed = (name) => CONTROLLER_ENV_NAME.test(name) && !CONTROLLER_IDENTITY_NAME.test(name);
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== void 0 && isAllowed(entry[0]))
  );
}
function remainingDeadline(deadlineAt, maximum) {
  if (deadlineAt === void 0) return maximum;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new LifecycleError("lifecycle_deadline_exceeded", "the lifecycle command exceeded its absolute deadline");
  return Math.min(maximum, remaining);
}
async function acquireWindowsMutex() {
  const script = "$mutex = New-Object System.Threading.Mutex($false, 'Local\\CodexOrchestrationLifecycle'); if (-not $mutex.WaitOne(0)) { exit 173 }; [Console]::Out.WriteLine('acquired'); [Console]::In.ReadLine() | Out-Null; $mutex.ReleaseMutex(); $mutex.Dispose()";
  const holder = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const acquired = await new Promise((resolve6) => {
    const timer = setTimeout(() => resolve6(false), 5e3);
    holder.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve6(String(chunk).trim() === "acquired");
    });
    holder.once("error", () => {
      clearTimeout(timer);
      resolve6(false);
    });
    holder.once("close", () => {
      clearTimeout(timer);
      resolve6(false);
    });
  });
  if (!acquired) {
    holder.kill();
    throw new LifecycleError("lifecycle_busy", "another Codex Orchestration lifecycle command is already running");
  }
  return async () => {
    holder.stdin.end();
    if (holder.exitCode === null) await once(holder, "close");
  };
}
async function withMutex(_p, work) {
  const release = await acquireWindowsMutex();
  try {
    return await work();
  } finally {
    await release();
  }
}
async function configuredClient(p) {
  return ManagedClient.fromConfig(void 0, p.root);
}
async function configuredValidation(p) {
  return validateConfig(p.root);
}
function boundedStartupLogCause(contents) {
  const exitAtom = Array.from(contents.matchAll(/\*\* \(EXIT\) :([a-z][a-z0-9_]{1,80})/g)).at(-1)?.[1];
  if (exitAtom) return exitAtom;
  const missing = Array.from(contents.matchAll(/\b(missing_[a-z][a-z0-9_]{1,80})\b/g)).at(-1)?.[1];
  return missing;
}
function freshStartupLogCause(contents, modifiedAt, launchAt) {
  if (!Number.isFinite(modifiedAt) || modifiedAt < launchAt) return void 0;
  return boundedStartupLogCause(contents);
}
async function latestStartupLogCause(p, launchAt) {
  try {
    const directory = join2(p.logs, "log");
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^symphony\.log\.\d+$/.test(entry.name));
    const files = await Promise.all(entries.map(async (entry) => {
      const path = join2(directory, entry.name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
    const latest = files.sort((left, right) => right.modified - left.modified)[0];
    if (!latest || latest.modified < launchAt) return void 0;
    const details = await stat(latest.path);
    const length = Math.min(details.size, 16 * 1024);
    const handle = await open(latest.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, details.size - length));
      return freshStartupLogCause(buffer.toString("utf8"), details.mtimeMs, launchAt);
    } finally {
      await handle.close();
    }
  } catch {
    return void 0;
  }
}
async function terminalStartupFailure(p, launchAt) {
  try {
    const task = await taskDiagnostics(p);
    const lastRun = task.lastRunTime ? Date.parse(task.lastRunTime) : Number.NaN;
    if (task.active || !Number.isFinite(lastRun) || lastRun < launchAt - 2e3) return void 0;
    const cause = await latestStartupLogCause(p, launchAt);
    const result = task.lastTaskResult ?? "unknown";
    return "scheduled task exited during startup with result " + result + (cause ? ": " + cause : "");
  } catch {
    return void 0;
  }
}
async function waitUntilReady(p, lifecycleDeadline, launchAt = Date.now()) {
  const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, lifecycleDeadline ?? Number.POSITIVE_INFINITY);
  let diagnostic = "task launch";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer;
    try {
      const client = await Promise.race([
        configuredClient(p),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new LifecycleError("readiness_timeout", "readiness probe exceeded the 60-second deadline")), remaining);
        })
      ]);
      const probeRemaining = deadline - Date.now();
      if (probeRemaining <= 0) break;
      await client.state({}, probeRemaining);
      return;
    } catch (cause) {
      diagnostic = cause instanceof Error ? cause.message : "loopback probe failed";
      const terminal = await terminalStartupFailure(p, launchAt);
      if (terminal) throw new LifecycleError("startup_task_failed", terminal);
      const pause2 = Math.min(500, Math.max(0, deadline - Date.now()));
      if (pause2 > 0) await new Promise((done) => setTimeout(done, pause2));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new LifecycleError("readiness_timeout", "Symphony did not become ready within 60 seconds after task launch: " + diagnostic);
}
async function setupUnlocked(p, options) {
  const existingTask = await taskSnapshot(p);
  if (existingTask.exists && !await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
  if (existingTask.active) await stopOwnedTask(p);
  for (const directory of [p.root, p.releases, p.config, p.state, p.logs, p.workspaces]) await privateDirectory(directory);
  await writeControllerEnvironment(p);
  const port = await writeConfiguration(p, options);
  const existingWorkflow = await optional(p.workflow);
  const workflowState = existingWorkflow === void 0 ? { hasLauncher: false, hasLegacy: false } : workflowStatus(existingWorkflow);
  const workflowNeedsConfiguration = Boolean(options.workflow || options.launcher || existingWorkflow === void 0 || !workflowState.hasLauncher || workflowState.hasLegacy);
  if (workflowNeedsConfiguration) {
    await stageWorkflow(p, options.workflow, await resolveCodexLauncher(options.launcher));
  }
  if (options.executable || options.releaseManifest) await stageRelease(p, options, releaseVersion(options.version));
  if (!await optional(p.current)) throw new LifecycleError("release_missing", "provide --executable for the first install");
  await installTask(p, port);
  await atomic(p.metadata, JSON.stringify({ taskName: p.taskName, root: p.root, installedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2) + "\n");
  return p;
}
async function setup(options = {}) {
  const p = paths(options);
  return withMutex(p, () => setupUnlocked(p, options));
}
async function diagnostics(options = {}) {
  const p = paths(options);
  const config = await configuredValidation(p);
  const selected = await optional(p.current);
  const previous = await optional(p.previous);
  let nativeTask;
  let inspectionError;
  try {
    nativeTask = await taskDiagnostics(p);
  } catch (error) {
    nativeTask = { exists: false, running: false, active: false };
    inspectionError = error instanceof LifecycleError ? error.message : "could not inspect the orchestration scheduled task";
  }
  let owned = !nativeTask.exists;
  if (nativeTask.exists) {
    try {
      owned = await taskOwned(p);
    } catch {
      owned = false;
    }
  }
  const release = await releaseEntryDiagnostics(p, selected);
  const task = {
    name: p.taskName,
    exists: nativeTask.exists,
    state: nativeTask.state ?? null,
    running: nativeTask.running,
    active: nativeTask.active,
    owned,
    lastTaskResult: nativeTask.lastTaskResult ?? null,
    lastRunTime: nativeTask.lastRunTime ?? null,
    nextRunTime: nativeTask.nextRunTime ?? null,
    action: nativeTask.action ?? null,
    inspectionError: inspectionError ?? null
  };
  const startup = {
    configValid: config.valid,
    taskExists: nativeTask.exists,
    taskOwned: owned,
    taskState: nativeTask.state ?? null,
    lastTaskResult: nativeTask.lastTaskResult ?? null,
    lastRunTime: nativeTask.lastRunTime ?? null,
    selectedRelease: release,
    action: nativeTask.action ?? { command: "powershell.exe", arguments: '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + p.runner + '"', hidden: true },
    issue: inspectionError || !config.valid ? inspectionError || config.error || "configuration is invalid" : !nativeTask.exists ? "scheduled task is not installed" : !owned ? "scheduled task is not owned by this installation" : !release.valid ? String(release.error) : void 0
  };
  return { valid: config.valid && !inspectionError && nativeTask.exists && owned && release.valid, config, task, startup, paths: p, release: selected, previousRelease: previous };
}
async function start(options = {}) {
  const p = paths(options);
  return withMutex(p, async () => {
    const current = await optional(p.current);
    const task = await taskSnapshot(p);
    if (task.exists && !await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
    const needsSetup = Boolean(options.executable || options.releaseManifest || options.workflow || options.port !== void 0 || options.tokenFile || options.launcher || !current || !task.exists);
    if (needsSetup) await setupUnlocked(p, options);
    else {
      const config = await configuredValidation(p);
      if (!config.valid) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    }
    const launchAt = Date.now();
    await run("schtasks.exe", ["/Run", "/TN", p.taskName]);
    await waitUntilReady(p, options.deadlineAt, launchAt);
    return p;
  });
}
async function serviceControl(options, operation, disable) {
  const p = paths(options);
  let state;
  const client = await configuredClient(p);
  try {
    state = await client.state();
  } catch (cause) {
    if (cause instanceof BridgeError) throw new LifecycleError(cause.code, cause.message);
    throw cause;
  }
  if (!Number.isInteger(state.revision)) throw new LifecycleError("state_invalid", "managed state did not include a current revision");
  return client.control({ request_id: "cli-" + operation + "-" + Date.now() + "-" + randomBytes(6).toString("hex"), operation, args: { scope: "service", expected_revision: state.revision, disable } });
}
async function pause(options = {}) {
  const p = paths(options);
  return withMutex(p, () => serviceControl(options, "pause", false));
}
async function resume(options = {}) {
  const p = paths(options);
  return withMutex(p, () => serviceControl(options, "resume", false));
}
async function stop(options = {}) {
  const p = paths(options);
  return withMutex(p, async () => {
    if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    let serviceError;
    let taskError;
    try {
      await serviceControl(options, "pause", true);
    } catch (error) {
      serviceError = error;
    }
    try {
      await stopTask(p);
    } catch (error) {
      taskError = error;
    }
    if (serviceError && taskError) {
      const describe = (error, fallback) => {
        if (error instanceof LifecycleError) return error.code + ": " + error.message;
        if (error instanceof Error) return error.message;
        return fallback;
      };
      const serviceMessage = describe(serviceError, "service control failed");
      const taskMessage = describe(taskError, "scheduled task stop failed");
      throw new LifecycleError("stop_failed", serviceMessage + "; " + taskMessage);
    }
    if (serviceError) throw serviceError;
    if (taskError) throw taskError;
    return p;
  });
}
async function upgrade(options) {
  if (!options.executable && !options.releaseManifest) throw new LifecycleError("release_source_required", "upgrade requires --release-manifest or an offline --executable ZIP with --sha256");
  const p = paths(options);
  return withMutex(p, async () => {
    if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    const active = await taskRunning(p);
    await stopOwnedTask(p);
    await stageRelease(p, options, releaseVersion(options.version));
    const config = await configuredValidation(p);
    if (!config.valid || !config.port) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    await installTask(p, config.port);
    if (active) {
      const launchAt = Date.now();
      await run("schtasks.exe", ["/Run", "/TN", p.taskName]);
      await waitUntilReady(p, options.deadlineAt, launchAt);
    }
    return p;
  });
}
async function rollback(options = {}) {
  const p = paths(options);
  return withMutex(p, async () => {
    if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    const previous = await optional(p.previous);
    const current = await optional(p.current);
    if (!previous || !current) throw new LifecycleError("rollback_unavailable", "no previous release is available for rollback");
    const active = await taskRunning(p);
    await stopOwnedTask(p);
    await atomic(p.current, previous + "\n");
    await atomic(p.previous, current + "\n");
    const config = await configuredValidation(p);
    if (!config.valid || !config.port) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    await installTask(p, config.port);
    if (active) {
      const launchAt = Date.now();
      await run("schtasks.exe", ["/Run", "/TN", p.taskName]);
      await waitUntilReady(p, options.deadlineAt, launchAt);
    }
    return p;
  });
}
async function uninstall(options = {}) {
  const p = paths(options);
  return withMutex(p, async () => {
    if (!await taskOwned(p)) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    await stopOwnedTask(p);
    if (await taskExists(p)) await run("schtasks.exe", ["/Delete", "/TN", p.taskName, "/F"]);
    await rm(p.launcher, { force: true });
    await rm(p.runner, { force: true });
    await rm(p.taskXml, { force: true });
    await rm(p.metadata, { force: true });
    return p;
  });
}
async function validateConfigForHost(testRoot) {
  return validateConfig(testRoot);
}

// src/lifecycle_task.ts
import { execFile as execFileCallback3 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat as lstat3, mkdir as mkdir2, readFile as readFile3, rename as rename2, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { basename, dirname as dirname3, isAbsolute as isAbsolute4, join as join3, resolve as resolve4 } from "node:path";
import { promisify as promisify3 } from "node:util";
var execFile3 = promisify3(execFileCallback3);
var TASK_PREFIX = "Codex-Orchestration-Lifecycle-";
var TASK_DEADLINE_MS = 18e4;
var RESULT_MAX_BYTES = 4 * 1024 * 1024;
var REQUEST_MAX_BYTES = 1024 * 1024;
var MUTATIONS = /* @__PURE__ */ new Set(["setup", "start", "pause", "resume", "stop", "upgrade", "rollback", "uninstall"]);
function isLifecycleMutation(command2) {
  return MUTATIONS.has(command2);
}
function lifecycleRunOutcomeIsUncertain(runRequested, resultValidated) {
  return runRequested && !resultValidated;
}
function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function quoteWindowsArgument(value) {
  if (value.length > 0 && !/[\s\"]/.test(value)) return value;
  let output = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      output += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      output += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return output + "\\".repeat(backslashes * 2) + '"';
}
function lifecycleTaskArguments(cli, request, nonce) {
  return [cli, "--lifecycle-task-child", request, nonce].map(quoteWindowsArgument).join(" ");
}
function lifecycleTaskXml(node, cli, request, nonce, userSid) {
  const argumentsValue = lifecycleTaskArguments(cli, request, nonce);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>Codex Orchestration one-shot lifecycle " + xml(nonce) + "</Description></RegistrationInfo>",
    "  <Triggers />",
    '  <Principals><Principal id="Author"><UserId>' + xml(userSid) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "  <Settings><Hidden>true</Hidden><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT4M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
    '  <Actions Context="Author"><Exec><Command>' + xml(node) + "</Command><Arguments>" + xml(argumentsValue) + "</Arguments><WorkingDirectory>" + xml(dirname3(cli)) + "</WorkingDirectory></Exec></Actions>",
    "</Task>",
    ""
  ].join("\r\n");
}
async function command(executable, args, allowFailure = false) {
  try {
    const result = await execFile3(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15e3 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error;
    const code = typeof detail.code === "number" ? detail.code : 1;
    if (allowFailure) return { code, stdout: detail.stdout || "", stderr: detail.stderr || "" };
    const message = String(detail.stderr || detail.stdout || "").trim().slice(0, 500);
    throw new LifecycleError("lifecycle_task_command_failed", basename(executable) + " failed" + (message ? ": " + message : ""), code);
  }
}
async function currentSid2() {
  const result = await command("whoami.exe", ["/user"]);
  const sid = result.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  return sid;
}
function samePath(left, right) {
  return resolve4(left).toLocaleLowerCase("en-US") === resolve4(right).toLocaleLowerCase("en-US");
}
async function regularFile2(path, label) {
  const absolute2 = resolve4(path);
  if (!isAbsolute4(path)) throw new LifecycleError("lifecycle_task_invalid", label + " must be an absolute path");
  try {
    if (!(await stat2(absolute2)).isFile()) throw new Error("not a file");
    return absolute2;
  } catch {
    throw new LifecycleError("lifecycle_task_invalid", label + " is not a regular file: " + absolute2);
  }
}
async function privateInvocationDirectory(path, sid) {
  await mkdir2(path, { recursive: false });
  const link = await lstat3(path);
  if (link.isSymbolicLink()) throw new LifecycleError("lifecycle_task_invalid", "lifecycle staging cannot be a reparse-point link");
  const checks = [
    [path, "/grant:r", "*" + sid + ":F"],
    [path, "/inheritance:r"],
    [path, "/grant:r", "*" + sid + ":(OI)(CI)F"],
    [path, "/setowner", "*" + sid]
  ];
  for (const args of checks) {
    const result = await command("icacls.exe", args, true);
    if (result.code !== 0 || /Failed processing\s+[1-9]/i.test(result.stdout + result.stderr)) {
      throw new LifecycleError("lifecycle_task_acl_failed", "could not protect the private lifecycle request staging directory");
    }
  }
}
async function removeInvocationDirectory(path, bridgeRoot, nonce) {
  if (dirname3(resolve4(path)) !== resolve4(bridgeRoot) || basename(path) !== nonce) {
    throw new LifecycleError("lifecycle_task_cleanup_failed", "lifecycle staging cleanup target escaped its owned root");
  }
  try {
    if ((await lstat3(path)).isSymbolicLink()) throw new LifecycleError("lifecycle_task_cleanup_failed", "lifecycle staging cleanup target became a reparse-point link");
    await rm2(path, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function atomic2(path, contents) {
  const temporary = path + ".tmp-" + randomUUID();
  await writeFile2(temporary, contents, { mode: 384 });
  await rename2(temporary, path);
}
async function readBounded(path, maximum) {
  const details = await stat2(path);
  if (!details.isFile() || details.size > maximum) throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task output is missing or exceeds its bounded size");
  return readFile3(path);
}
function strictObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("lifecycle_task_result_invalid", label + " must be an object");
  const record = value;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new LifecycleError("lifecycle_task_result_invalid", label + " contains an unexpected field");
  return record;
}
async function taskSnapshot2(taskName) {
  const safeName = taskName.replaceAll("'", "''");
  const script = [
    "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq '" + safeName + "' -and $_.TaskPath -eq '\\' })",
    `if ($tasks.Count -eq 0) { [Console]::WriteLine('{"exists":false}'); exit 0 }`,
    "$task = $tasks[0]",
    "$action = @($task.Actions)[0]",
    "$state = [int]$task.State",
    "$principal = [string]$task.Principal.UserId",
    "$principalSid = if ($principal -match '^S-\\d-') { $principal } else { (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value }",
    "[Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ exists=$true; active=($state -eq 2 -or $state -eq 4); userId=$principalSid; execute=[string]$action.Execute; arguments=[string]$action.Arguments; workingDirectory=[string]$action.WorkingDirectory }))"
  ].join("; ");
  const result = await command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  try {
    const value = JSON.parse(result.stdout.trim());
    if (typeof value.exists !== "boolean") throw new Error("invalid");
    return value;
  } catch {
    throw new LifecycleError("lifecycle_task_inspection_failed", "could not inspect the temporary lifecycle task");
  }
}
function verifiedSnapshot(snapshot, node, expectedArguments, workingDirectory, userSid) {
  return snapshot.exists === true && snapshot.userId?.toLocaleLowerCase("en-US") === userSid.toLocaleLowerCase("en-US") && typeof snapshot.execute === "string" && samePath(snapshot.execute, node) && snapshot.arguments === expectedArguments && typeof snapshot.workingDirectory === "string" && samePath(snapshot.workingDirectory, workingDirectory);
}
async function stopAndDeleteVerifiedTask(taskName, node, expectedArguments, workingDirectory, userSid) {
  let snapshot = await taskSnapshot2(taskName);
  if (!snapshot.exists) return;
  if (!verifiedSnapshot(snapshot, node, expectedArguments, workingDirectory, userSid)) {
    throw new LifecycleError("lifecycle_task_identity_mismatch", "temporary lifecycle task identity changed; it was not stopped or deleted");
  }
  if (snapshot.active) {
    await command("schtasks.exe", ["/End", "/TN", taskName], true);
    const deadline = Date.now() + 1e4;
    do {
      await new Promise((done) => setTimeout(done, 100));
      snapshot = await taskSnapshot2(taskName);
      if (!snapshot.exists || !snapshot.active) break;
    } while (Date.now() < deadline);
    if (snapshot.exists && snapshot.active) throw new LifecycleError("lifecycle_task_cleanup_uncertain", "temporary lifecycle task did not become inactive and was not deleted");
  }
  const removed = await command("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], true);
  if ((await taskSnapshot2(taskName)).exists) {
    throw new LifecycleError("lifecycle_task_cleanup_failed", "temporary lifecycle task could not be deleted");
  }
  if (removed.code !== 0) return;
}
function parseResult(value, request) {
  const result = strictObject(value, ["schemaVersion", "nonce", "operation", "exitCode", "requestFinalPath", "root", "rootFinalPath", "configFinalPath", "tokenFinalPath"], "lifecycle task result");
  if (result.schemaVersion !== 1 || result.nonce !== request.nonce || result.operation !== request.operation || result.root !== request.root) {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task result did not match its request identity");
  }
  if (!Number.isInteger(result.exitCode) || Number(result.exitCode) < 0 || Number(result.exitCode) > 4294967295) {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task returned an invalid exit code");
  }
  if (typeof result.requestFinalPath !== "string" || result.rootFinalPath !== null && typeof result.rootFinalPath !== "string" || result.configFinalPath !== null && typeof result.configFinalPath !== "string" || result.tokenFinalPath !== null && typeof result.tokenFinalPath !== "string") {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task omitted its physical-path evidence");
  }
  return result;
}
async function parseRequest(path, nonce) {
  const bytes = await readBounded(path, REQUEST_MAX_BYTES);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request is not valid JSON");
  }
  const raw = strictObject(value, ["schemaVersion", "nonce", "operation", "args", "userSid", "deadlineAt", "root", "controllerEnvironment"], "lifecycle task request");
  if (raw.schemaVersion !== 1 || raw.nonce !== nonce || typeof raw.operation !== "string" || !MUTATIONS.has(raw.operation)) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request identity or operation is invalid");
  }
  if (!Array.isArray(raw.args) || raw.args.some((entry) => typeof entry !== "string") || JSON.stringify(raw.args).length > 128 * 1024) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request arguments are invalid");
  }
  if (typeof raw.userSid !== "string" || !/^S-\d-\d+(?:-\d+)+$/.test(raw.userSid)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request SID is invalid");
  if (!Number.isSafeInteger(raw.deadlineAt) || Number(raw.deadlineAt) <= Date.now() || Number(raw.deadlineAt) > Date.now() + TASK_DEADLINE_MS + 1e4) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request deadline is invalid");
  }
  if (typeof raw.root !== "string" || !isAbsolute4(raw.root)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request root is invalid");
  const environmentRaw = strictObject(raw.controllerEnvironment, Object.keys(raw.controllerEnvironment), "controller environment");
  if (Object.values(environmentRaw).some((entry) => typeof entry !== "string")) throw new LifecycleError("lifecycle_task_request_invalid", "controller environment values must be strings");
  const environment = captureControllerEnvironment(environmentRaw);
  if (Object.keys(environment).length !== Object.keys(environmentRaw).length) throw new LifecycleError("lifecycle_task_request_invalid", "controller environment contains a disallowed name");
  return { ...raw, args: raw.args, deadlineAt: Number(raw.deadlineAt), controllerEnvironment: environment };
}
function lifecycleErrorText(error) {
  if (error instanceof LifecycleError) return { code: error.code === "usage" ? 2 : 1, text: error.code + ": " + error.message };
  return { code: 1, text: "lifecycle_error: The orchestration lifecycle command failed" };
}
async function runLifecycleTaskChild(requestPath, nonce, dispatch, testRoot) {
  const absoluteRequest = resolve4(requestPath);
  const invocation = dirname3(absoluteRequest);
  const stdoutPath = join3(invocation, "stdout.txt");
  const stderrPath = join3(invocation, "stderr.txt");
  const resultPath = join3(invocation, "result.json");
  let request;
  let exitCode = 1;
  let output = "";
  let errorOutput = "";
  let rootFinalPath = null;
  let configFinalPath = null;
  let tokenFinalPath = null;
  let requestFinalPath = absoluteRequest;
  try {
    request = await parseRequest(absoluteRequest, nonce);
    const fixedRoot = orchestrationPaths(process.env, testRoot).root;
    if (!samePath(request.root, fixedRoot)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request root is not the fixed orchestration root");
    if ((await currentSid2()).toLocaleLowerCase("en-US") !== request.userSid.toLocaleLowerCase("en-US")) {
      throw new LifecycleError("lifecycle_task_identity_mismatch", "temporary lifecycle task did not run as the requesting Windows user");
    }
    requestFinalPath = realpathSync.native(absoluteRequest);
    for (const name of Object.keys(process.env)) {
      if (Object.keys(captureControllerEnvironment({ [name]: process.env[name] })).length > 0) delete process.env[name];
    }
    Object.assign(process.env, request.controllerEnvironment);
    const value = await dispatch(request.operation, request.args, request.deadlineAt);
    const resolvedPaths = orchestrationPaths(process.env, testRoot);
    rootFinalPath = realpathSync.native(resolvedPaths.root);
    if (!samePath(request.root, rootFinalPath)) throw new LifecycleError("virtualized_installation_root", "lifecycle task did not resolve the physical orchestration root");
    configFinalPath = realpathSync.native(resolvedPaths.bridgeConfig);
    tokenFinalPath = realpathSync.native(resolvedPaths.token);
    if (!samePath(configFinalPath, resolvedPaths.bridgeConfig) || !samePath(tokenFinalPath, resolvedPaths.token)) {
      throw new LifecycleError("virtualized_installation_root", "lifecycle task did not resolve the physical orchestration configuration files");
    }
    output = JSON.stringify(value, null, 2) + "\n";
    exitCode = 0;
  } catch (error) {
    const failure = lifecycleErrorText(error);
    exitCode = failure.code;
    errorOutput = failure.text + "\n";
  }
  await atomic2(stdoutPath, output);
  await atomic2(stderrPath, errorOutput);
  const result = {
    schemaVersion: 1,
    nonce,
    operation: request?.operation || "invalid",
    exitCode,
    requestFinalPath,
    root: request?.root || "",
    rootFinalPath,
    configFinalPath,
    tokenFinalPath
  };
  await atomic2(resultPath, JSON.stringify(result));
  return exitCode;
}
async function runLifecycleViaTask(cliInput, argv, testRoot) {
  if (process.platform !== "win32") throw new LifecycleError("platform_unsupported", "Codex Orchestration lifecycle commands require Windows");
  const operation = argv[0] || "";
  if (!MUTATIONS.has(operation)) throw new LifecycleError("lifecycle_task_invalid", "only lifecycle mutations can use the one-shot task boundary");
  const cli = await regularFile2(cliInput, "CLI entrypoint");
  const node = await regularFile2(process.execPath, "Node executable");
  if (basename(node).toLocaleLowerCase("en-US") !== "node.exe") throw new LifecycleError("lifecycle_task_invalid", "lifecycle task requires the public node.exe entrypoint");
  const pluginRoot = dirname3(dirname3(cli));
  await regularFile2(join3(pluginRoot, ".codex-plugin", "plugin.json"), "plugin manifest");
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile || !isAbsolute4(userProfile)) throw new LifecycleError("lifecycle_task_invalid", "USERPROFILE must be an absolute Windows path");
  const sid = await currentSid2();
  const nonce = randomUUID().replaceAll("-", "");
  const taskName = TASK_PREFIX + nonce;
  const bridgeRoot = join3(resolve4(userProfile), ".codex", "orchestration-lifecycle");
  await mkdir2(bridgeRoot, { recursive: true });
  const invocation = join3(bridgeRoot, nonce);
  const requestPath = join3(invocation, "request.json");
  const resultPath = join3(invocation, "result.json");
  const stdoutPath = join3(invocation, "stdout.txt");
  const stderrPath = join3(invocation, "stderr.txt");
  const taskXmlPath = join3(invocation, "task.xml");
  const deadlineAt = Date.now() + TASK_DEADLINE_MS;
  const expectedRoot = orchestrationPaths(process.env, testRoot).root;
  const request = {
    schemaVersion: 1,
    nonce,
    operation,
    args: argv.slice(1),
    userSid: sid,
    deadlineAt,
    root: expectedRoot,
    controllerEnvironment: captureControllerEnvironment(process.env)
  };
  const expectedArguments = lifecycleTaskArguments(cli, requestPath, nonce);
  try {
    await privateInvocationDirectory(invocation, sid);
    await atomic2(requestPath, JSON.stringify(request));
    await atomic2(taskXmlPath, Buffer.from("\uFEFF" + lifecycleTaskXml(node, cli, requestPath, nonce, sid), "utf16le"));
  } catch (error) {
    await removeInvocationDirectory(invocation, bridgeRoot, nonce);
    throw error;
  }
  let createAttempted = false;
  let created = false;
  let runRequested = false;
  let resultValidated = false;
  let preserveInvocation = false;
  let pendingError;
  let taskResult;
  let stdout = "";
  let stderr = "";
  try {
    createAttempted = true;
    await command("schtasks.exe", ["/Create", "/TN", taskName, "/XML", taskXmlPath, "/F"]);
    created = true;
    const before = await taskSnapshot2(taskName);
    if (!verifiedSnapshot(before, node, expectedArguments, dirname3(cli), sid)) {
      preserveInvocation = true;
      throw new LifecycleError("lifecycle_task_identity_mismatch", "temporary lifecycle task did not preserve its SID, action, and nonce");
    }
    runRequested = true;
    await command("schtasks.exe", ["/Run", "/TN", taskName]);
    while (Date.now() < deadlineAt) {
      try {
        const bytes = await readBounded(resultPath, REQUEST_MAX_BYTES);
        taskResult = parseResult(JSON.parse(bytes.toString("utf8")), request);
        resultValidated = true;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!taskResult) throw new LifecycleError("lifecycle_outcome_uncertain", "temporary lifecycle task exceeded its absolute deadline; it will not be replayed");
    const requestFinalPath = realpathSync.native(requestPath);
    if (!samePath(taskResult.requestFinalPath, requestFinalPath)) throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task result did not attest the private request path");
    if (taskResult.exitCode === 0) {
      const resolvedPaths = orchestrationPaths(process.env, testRoot);
      if (!taskResult.rootFinalPath || !taskResult.configFinalPath || !taskResult.tokenFinalPath || !samePath(taskResult.root, taskResult.rootFinalPath) || !samePath(taskResult.configFinalPath, resolvedPaths.bridgeConfig) || !samePath(taskResult.tokenFinalPath, resolvedPaths.token)) {
        throw new LifecycleError("virtualized_installation_root", "lifecycle task did not attest the physical orchestration root and configuration files");
      }
      const parentRootFinalPath = realpathSync.native(expectedRoot);
      const parentConfigFinalPath = realpathSync.native(resolvedPaths.bridgeConfig);
      const parentTokenFinalPath = realpathSync.native(resolvedPaths.token);
      if (!samePath(parentRootFinalPath, taskResult.rootFinalPath)) {
        throw new LifecycleError("virtualized_state_conflict", "Codex sees a different AppData root than the lifecycle task; archive the stale virtualized shadow before retrying");
      }
      if (!samePath(parentConfigFinalPath, taskResult.configFinalPath) || !samePath(parentTokenFinalPath, taskResult.tokenFinalPath)) {
        throw new LifecycleError("virtualized_state_conflict", "Codex sees different configuration files than the lifecycle task; archive the stale virtualized shadow before retrying");
      }
    }
    stdout = (await readBounded(stdoutPath, RESULT_MAX_BYTES)).toString("utf8");
    stderr = (await readBounded(stderrPath, RESULT_MAX_BYTES)).toString("utf8");
  } catch (error) {
    pendingError = error;
  }
  if (createAttempted && !created && !preserveInvocation) {
    try {
      const ambiguous = await taskSnapshot2(taskName);
      if (ambiguous.exists) {
        if (!verifiedSnapshot(ambiguous, node, expectedArguments, dirname3(cli), sid)) {
          preserveInvocation = true;
          pendingError = new LifecycleError("lifecycle_task_cleanup_uncertain", "task creation outcome was uncertain and the nonce task identity could not be verified");
        } else {
          created = true;
        }
      }
    } catch {
      preserveInvocation = true;
      pendingError = new LifecycleError("lifecycle_task_cleanup_uncertain", "task creation outcome was uncertain and could not be inspected");
    }
  }
  if (created && !preserveInvocation) {
    try {
      await stopAndDeleteVerifiedTask(taskName, node, expectedArguments, dirname3(cli), sid);
      created = false;
    } catch (cleanupError) {
      pendingError = cleanupError;
      preserveInvocation = true;
    }
  }
  if (lifecycleRunOutcomeIsUncertain(runRequested, resultValidated) && pendingError && !(pendingError instanceof LifecycleError && pendingError.code === "lifecycle_outcome_uncertain")) {
    pendingError = new LifecycleError("lifecycle_outcome_uncertain", "temporary lifecycle task ended without a validated result; it will not be replayed");
  }
  if (!preserveInvocation) await removeInvocationDirectory(invocation, bridgeRoot, nonce);
  if (pendingError) throw pendingError;
  if (!taskResult) throw new LifecycleError("lifecycle_task_result_invalid", "temporary lifecycle task returned no result");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return taskResult.exitCode;
}

// src/cli.ts
var usage = `Usage:
  codex-orchestration validate-config
  codex-orchestration diagnostics
  codex-orchestration setup (--release-manifest PATH | --executable ZIP --sha256 SHA256) --workflow PATH [--version VERSION] [--port PORT]
  codex-orchestration start [setup options]
  codex-orchestration pause | resume | stop | rollback | uninstall
  codex-orchestration upgrade (--release-manifest PATH | --executable ZIP --sha256 SHA256) [--version VERSION]
  codex-orchestration control --input PATH`;
var OPERATOR_CONTROL_OPERATIONS = /* @__PURE__ */ new Set(["bind_project", "pause", "resume", "operator_takeover"]);
var CONTROL_INPUT_MAX_BYTES = 1048576;
function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--")) throw new LifecycleError("usage", `unexpected argument: ${name}`);
    const key = name.slice(2);
    if (key === "help") throw new LifecycleError("usage", usage);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new LifecycleError("usage", `${name} requires a value`);
    if (key === "executable") options.executable = value;
    else if (key === "release-manifest") options.releaseManifest = value;
    else if (key === "sha256") options.sha256 = value;
    else if (key === "workflow") options.workflow = value;
    else if (key === "version") options.version = value;
    else if (key === "port") options.port = Number(value);
    else if (key === "token-file") options.tokenFile = value;
    else if (key === "launcher") options.launcher = value;
    else throw new LifecycleError("usage", `unknown option: ${name}`);
  }
  return options;
}
function parseControlOptions(values) {
  let inputFile;
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
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function readControlEnvelope(inputFile) {
  let contents;
  try {
    const bytes = await readFile4(inputFile);
    if (bytes.byteLength > CONTROL_INPUT_MAX_BYTES) throw new LifecycleError("control_input_too_large", "control input exceeds the private envelope limit");
    contents = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError("control_input_unreadable", "control input could not be read");
  }
  let value;
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
  if (typeof operation !== "string" || !OPERATOR_CONTROL_OPERATIONS.has(operation)) {
    throw new LifecycleError("operator_required", "control accepts bind_project, service pause/resume, and operator_takeover only");
  }
  if (!plainObject(args)) throw new LifecycleError("control_input_invalid", "control input args must be a JSON object");
  if ((operation === "pause" || operation === "resume") && args.scope !== "service") {
    throw new LifecycleError("operator_required", `${operation} control input must use scope service`);
  }
  return { request_id: requestId, operation, args };
}
async function control(inputFile, testRoot) {
  const request = await readControlEnvelope(inputFile);
  try {
    const client = await ManagedClient.fromConfig(void 0, testRoot);
    return await client.control(request);
  } catch (error) {
    if (error instanceof BridgeError) throw new LifecycleError(error.code, error.message, error.status);
    throw error;
  }
}
function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
async function lifecycleMutation(command2, args, deadlineAt) {
  const options = parseOptions(args);
  options.deadlineAt = deadlineAt;
  if (command2 === "setup") return setup(options);
  if (command2 === "start") return start(options);
  if (command2 === "pause") return pause(options);
  if (command2 === "resume") return resume(options);
  if (command2 === "stop") return stop(options);
  if (command2 === "upgrade") return upgrade(options);
  if (command2 === "rollback") return rollback(options);
  if (command2 === "uninstall") return uninstall(options);
  throw new LifecycleError("usage", `unknown lifecycle command: ${command2}`);
}
async function runCli(argv = process.argv.slice(2), testRoot) {
  try {
    const [command2 = "help", ...args] = argv;
    if (command2 === "--lifecycle-task-child") {
      if (args.length !== 2) throw new LifecycleError("lifecycle_task_request_invalid", "lifecycle task child requires a request path and nonce");
      return runLifecycleTaskChild(args[0], args[1], lifecycleMutation);
    }
    if (isLifecycleMutation(command2)) return runLifecycleViaTask(process.argv[1], [command2, ...args]);
    if (command2 === "validate-config") {
      const diagnostic = await validateConfigForHost(testRoot);
      print(diagnostic);
      return diagnostic.valid ? 0 : 1;
    }
    if (command2 === "help") {
      console.log(usage);
      return 0;
    }
    if (command2 === "control") {
      print(await control(parseControlOptions(args), testRoot));
      return 0;
    }
    const options = parseOptions(args);
    if (command2 === "diagnostics") {
      print(await diagnostics(options));
      return 0;
    }
    throw new LifecycleError("usage", `unknown command: ${command2}
${usage}`);
  } catch (error) {
    const lifecycle = error instanceof LifecycleError ? error : new LifecycleError("lifecycle_error", "The orchestration lifecycle command failed");
    console.error(`${lifecycle.code}: ${lifecycle.message}`);
    return lifecycle.code === "usage" ? 2 : 1;
  }
}
if (process.argv[1] && resolve5(process.argv[1]) === resolve5(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli();
}
export {
  runCli
};
