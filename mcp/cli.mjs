var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/paths.ts
import { resolve, win32 } from "node:path";
function toWslPath(input) {
  const absolute = win32.resolve(input);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) throw new Error("plugin path must be on a local Windows drive");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}
function fromWslPath(input) {
  const match = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(input);
  if (!match) throw new Error("WSL path must be on a local Windows drive");
  return win32.resolve(`${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`);
}
var init_paths = __esm({
  "src/paths.ts"() {
    "use strict";
  }
});

// src/config.ts
var config_exports = {};
__export(config_exports, {
  ConfigError: () => ConfigError,
  DEFAULT_MAX_INPUT_BYTES: () => DEFAULT_MAX_INPUT_BYTES,
  configFilePath: () => configFilePath,
  loadConfig: () => loadConfig,
  readToken: () => readToken,
  validateConfig: () => validateConfig
});
import { readFile, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve as resolve2 } from "node:path";
function configFilePath() {
  const explicit = process.env.CODEX_ORCHESTRATION_CONFIG;
  if (explicit?.trim()) return resolve2(explicit);
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "codex-orchestration", "config.json");
}
function safeConfigError(error) {
  if (error instanceof ConfigError) return error;
  return new ConfigError("config_invalid", "Configuration could not be read");
}
function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}
async function loadConfig() {
  const path = configFilePath();
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError("config_missing", `Configuration file not found: ${path}`);
    }
    throw safeConfigError(error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("config_invalid", "Configuration must be a JSON object");
  }
  const raw = value;
  const host = raw.host;
  const port = raw.port;
  const token = raw.token_file;
  const maxInputBytes = raw.max_input_bytes ?? DEFAULT_MAX_INPUT_BYTES;
  if (!isLoopbackHost(host)) {
    throw new ConfigError("config_non_loopback", "host must be localhost, 127.0.0.1, or ::1");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("config_port_invalid", "port must be an integer from 1 through 65535");
  }
  if (typeof token !== "string" || token.trim() === "") {
    throw new ConfigError("config_token_invalid", "token_file must be a non-empty path");
  }
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 1024 || maxInputBytes > DEFAULT_MAX_INPUT_BYTES) {
    throw new ConfigError("config_input_limit_invalid", "max_input_bytes must be between 1024 and 16384");
  }
  const tokenFile = platform() === "win32" && /^\/mnt\/[A-Za-z]\//.test(token) ? fromWslPath(token) : isAbsolute(token) ? resolve2(token) : resolve2(dirname(path), token);
  await verifyTokenFile(tokenFile);
  return { host, port, tokenFile, maxInputBytes };
}
async function verifyTokenFile(tokenFile) {
  let details;
  try {
    details = await stat(tokenFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ConfigError("config_token_missing", "token_file does not exist");
    }
    throw new ConfigError("config_token_unreadable", "token_file could not be inspected");
  }
  if (!details.isFile()) throw new ConfigError("config_token_invalid", "token_file must be a regular file");
  if (platform() !== "win32" && (details.mode & 63) !== 0) {
    throw new ConfigError("config_token_permissions", "token_file permissions are too broad; use owner-only permissions");
  }
}
async function readToken(config) {
  try {
    const token = (await readFile(config.tokenFile, "utf8")).trim();
    if (!token) throw new ConfigError("config_token_empty", "token_file is empty");
    return token;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config_token_unreadable", "token_file could not be read");
  }
}
async function validateConfig() {
  const configFile = configFilePath();
  try {
    const config = await loadConfig();
    return { valid: true, configFile, host: config.host, port: config.port, tokenFile: config.tokenFile, maxInputBytes: config.maxInputBytes };
  } catch (error) {
    const safe = safeConfigError(error);
    return { valid: false, configFile, error: `${safe.code}: ${safe.message}` };
  }
}
var DEFAULT_MAX_INPUT_BYTES, ConfigError;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    init_paths();
    DEFAULT_MAX_INPUT_BYTES = 16 * 1024;
    ConfigError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "ConfigError";
        this.code = code;
      }
    };
  }
});

// src/cli.ts
init_config();

// src/lifecycle.ts
import { access, chmod, copyFile, lstat, mkdir, readFile as readFile2, rename, rm, stat as stat2, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir as homedir2, platform as platform2 } from "node:os";
import { dirname as dirname2, join as join2, resolve as resolve3, win32 as win322 } from "node:path";
import { randomBytes } from "node:crypto";

// src/client.ts
init_config();
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
  "revise",
  "pause",
  "resume",
  "interrupt",
  "cancel",
  "review"
]);
var MAX_RESPONSE_BYTES = 1048576;
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
var ManagedClient = class _ManagedClient {
  constructor(config, token) {
    this.config = config;
    this.token = token;
  }
  config;
  token;
  static async fromConfig() {
    const config = await loadConfig();
    return new _ManagedClient(config, await readToken(config));
  }
  async state() {
    return this.request("/api/v1/managed/state", { method: "GET" });
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
    });
  }
  async request(path, init) {
    const bodyBytes = init.body ? Buffer.byteLength(String(init.body), "utf8") : 0;
    if (bodyBytes > this.config.maxInputBytes) throw new BridgeError("request_too_large", "request exceeds configured input limit");
    let response;
    try {
      response = await fetch(`http://${endpointHost(this.config.host)}:${this.config.port}${path}`, {
        ...init,
        headers: { ...init.headers ?? {}, authorization: `Bearer ${this.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(65e3)
      });
    } catch {
      throw new BridgeError("upstream_unreachable", "Symphony loopback service is unavailable");
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
};

// src/lifecycle.ts
init_paths();
var execFile = promisify(nodeExecFile);
var SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.@-]{1,80}$/;
var RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_PORT = 8787;
var LifecycleError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.status = status;
  }
};
function lifecyclePaths(env = process.env, os = platform2()) {
  const home = env.USERPROFILE || env.HOME || homedir2();
  const root = env.CODEX_ORCHESTRATION_HOME?.trim();
  const configBase = env.XDG_CONFIG_HOME?.trim() || join2(home, ".config");
  const dataBase = env.XDG_DATA_HOME?.trim() || join2(home, ".local", "share");
  const stateBase = env.XDG_STATE_HOME?.trim() || join2(home, ".local", "state");
  const configRoot = root ? join2(root, "config") : join2(configBase, "codex-orchestration");
  const dataRoot = root ? join2(root, "data") : join2(dataBase, "codex-orchestration");
  const stateRoot = root ? join2(root, "state") : join2(stateBase, "codex-orchestration");
  const serviceName = env.CODEX_ORCHESTRATION_SERVICE_NAME?.trim() || "codex-orchestration.service";
  if (!SERVICE_NAME_PATTERN.test(serviceName.replace(/\.service$/, ""))) {
    throw new LifecycleError("service_name_invalid", "service name contains unsupported characters");
  }
  const taskName = env.CODEX_ORCHESTRATION_TASK_NAME?.trim() || `Codex-Orchestration-${randomBytes(4).toString("hex")}`;
  const unitRoot = root ? join2(root, "systemd", "user") : os === "win32" ? join2(configRoot, "systemd", "user") : join2(configBase, "systemd", "user");
  return {
    configRoot,
    dataRoot,
    stateRoot,
    releasesRoot: join2(dataRoot, "releases"),
    currentRelease: join2(dataRoot, "current-release"),
    previousRelease: join2(dataRoot, "previous-release"),
    wrapper: join2(dataRoot, "bin", "run-managed.sh"),
    workflow: join2(configRoot, "WORKFLOW.md"),
    token: join2(configRoot, "token"),
    bridgeConfig: join2(configRoot, "config.json"),
    logsRoot: join2(stateRoot, "logs"),
    journalRoot: join2(stateRoot, "journal"),
    workspacesRoot: join2(stateRoot, "workspaces"),
    lock: join2(stateRoot, "managed.lock"),
    unit: join2(unitRoot, serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`),
    launcher: join2(dataRoot, "bin", "windows-launcher.ps1"),
    taskXml: join2(dataRoot, "bin", "windows-task.xml"),
    metadata: join2(dataRoot, "installation.json"),
    enabledMarker: join2(stateRoot, "service-enabled"),
    serviceName: serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`,
    taskName
  };
}
function hostPath(input) {
  if (platform2() !== "win32" || !input.startsWith("/mnt/")) return resolve3(input);
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(input);
  if (!match) throw new LifecycleError("path_invalid", "WSL path must use a local mounted Windows drive");
  return win322.resolve(`${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`);
}
function servicePath(input) {
  return platform2() === "win32" ? toWslPath(input) : input;
}
function applyOptions(options) {
  if (options.root) process.env.CODEX_ORCHESTRATION_HOME = options.root;
  if (options.serviceName) process.env.CODEX_ORCHESTRATION_SERVICE_NAME = options.serviceName;
}
function quoteShell(input) {
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}
function unitQuote(input) {
  return `"${input.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}
function commandError(command, args, error) {
  const details = error;
  const output = `${details.stderr || details.stdout || ""}`.trim();
  return new LifecycleError("command_failed", `${command} ${args.join(" ")} failed${output ? `: ${output.slice(0, 500)}` : ""}`, typeof details.code === "number" ? details.code : void 0);
}
async function run(command, args, allowFailure = false, hostCommand = false) {
  const actualCommand = platform2() === "win32" && !hostCommand ? "wsl.exe" : command;
  const actualArgs = platform2() === "win32" && !hostCommand ? ["-d", "Ubuntu", "--", command, ...args] : args;
  try {
    const result = await execFile(actualCommand, actualArgs, { windowsHide: true, maxBuffer: 1048576 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    if (allowFailure) {
      const details = error;
      return { stdout: details.stdout || "", stderr: details.stderr || "", code: typeof details.code === "number" ? details.code : 1 };
    }
    throw commandError(command, args, error);
  }
}
async function runHost(command, args, allowFailure = false) {
  return run(command, args, allowFailure, true);
}
async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
  if (platform2() !== "win32") await chmod(path, 448);
}
async function writeAtomic(path, content, mode = 384) {
  await ensureDirectory(dirname2(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode });
  if (platform2() !== "win32") await chmod(temp, mode);
  await rename(temp, path);
}
async function readOptional(path) {
  try {
    return (await readFile2(path, "utf8")).trim() || void 0;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw new LifecycleError("read_failed", `could not read ${path}`);
  }
}
function validateVersion(version) {
  const value = version?.trim() || `local-${Date.now()}`;
  if (!RELEASE_PATTERN.test(value)) throw new LifecycleError("version_invalid", "version must contain only letters, numbers, dots, underscores, and hyphens");
  return value;
}
async function validateExecutable(input) {
  const path = hostPath(input);
  let details;
  try {
    details = await stat2(path);
    await access(path, constants.R_OK | (platform2() === "win32" ? 0 : constants.X_OK));
  } catch {
    throw new LifecycleError("executable_invalid", `executable is not readable: ${path}`);
  }
  if (!details.isFile()) throw new LifecycleError("executable_invalid", `executable is not a regular file: ${path}`);
  return path;
}
function serviceInvocation(paths, port) {
  const release = `$(cat -- ${quoteShell(servicePath(paths.currentRelease))})`;
  return [
    "#!/bin/sh",
    "set -eu",
    `release=${release}`,
    '[ -n "$release" ] || { echo "current release is empty" >&2; exit 78; }',
    `exec /usr/bin/flock --nonblock ${quoteShell(servicePath(paths.lock))} "$release" --managed --i-understand-that-this-will-be-running-without-the-usual-guardrails --logs-root ${quoteShell(servicePath(paths.logsRoot))} --port ${port} ${quoteShell(servicePath(paths.workflow))}`,
    ""
  ].join("\n");
}
function unitContent(paths) {
  const wrapper = servicePath(paths.wrapper);
  return [
    "[Unit]",
    "Description=Codex Orchestration managed Symphony",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${unitQuote(wrapper)}`,
    "KillMode=control-group",
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}
function windowsLauncher(paths) {
  const service = paths.serviceName.replace(/\.service$/, "");
  const marker = servicePath(paths.enabledMarker);
  const waitScript = `while [ -f ${quoteShell(marker)} ]; do sleep 5; done`;
  const powershellQuote = (input) => `'${input.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path -LiteralPath ${powershellQuote(paths.enabledMarker)})) { exit 0 }`,
    `wsl.exe -d Ubuntu -- systemctl --user start ${powershellQuote(service)}`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `wsl.exe -d Ubuntu -- bash -lc ${powershellQuote(waitScript)}`,
    "exit $LASTEXITCODE",
    ""
  ].join("\n");
}
function taskXml(paths, userSid) {
  const launcher = paths.launcher.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const taskName = paths.taskName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${taskName} keeps the Ubuntu WSL session available for the enabled managed service.</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><UserId>${userSid}</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${userSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "  <Settings><Enabled>false</Enabled><Hidden>true</Hidden><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
    `  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File &quot;${launcher}&quot;</Arguments></Exec></Actions>`,
    "</Task>",
    ""
  ].join("\n");
}
async function readMetadata(paths) {
  const raw = await readOptional(paths.metadata);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new LifecycleError("metadata_invalid", "installation metadata is invalid");
  }
}
async function unitOwnership(paths) {
  let details;
  try {
    details = await lstat(paths.unit);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw new LifecycleError("unit_inspection_failed", `could not inspect service unit ${paths.unit}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) return "foreign";
  const content = await readFile2(paths.unit, "utf8");
  const metadata = await readMetadata(paths);
  const expectedExec = `ExecStart=${unitQuote(servicePath(paths.wrapper))}`;
  return metadata.serviceName === paths.serviceName && content.includes("Description=Codex Orchestration managed Symphony") && content.includes(expectedExec) ? "owned" : "foreign";
}
function normalizedTaskText(value) {
  return value.replaceAll("&quot;", "").replaceAll('"', "").replaceAll("\\", "/").toLowerCase();
}
async function taskOwnership(paths) {
  if (platform2() !== "win32") return "missing";
  const query = await runHost("schtasks.exe", ["/Query", "/TN", paths.taskName, "/FO", "LIST"], true);
  if (query.code !== 0) {
    const output = `${query.stdout}
${query.stderr}`;
    if (/cannot find the file|cannot find file/i.test(output)) return "missing";
    throw new LifecycleError("task_inspection_failed", `could not inspect scheduled task ${paths.taskName}`);
  }
  const metadata = await readMetadata(paths);
  const task = paths.taskName.replaceAll("'", "''");
  const exported = await runHost("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Export-ScheduledTask -TaskName '${task}' | Out-String`], true);
  if (exported.code !== 0) throw new LifecycleError("task_inspection_failed", `could not inspect scheduled task ${paths.taskName}`);
  const content = exported.stdout;
  const description = `${paths.taskName} keeps the Ubuntu WSL session available for the enabled managed service.`;
  const normalized = normalizedTaskText(content);
  return metadata.serviceName === paths.serviceName && metadata.taskName === paths.taskName && content.includes(description) && normalized.includes(normalizedTaskText(paths.launcher)) ? "owned" : "foreign";
}
async function applyStoredTaskName(paths) {
  if (platform2() !== "win32") return;
  const metadata = await readMetadata(paths);
  if (metadata.serviceName === paths.serviceName && metadata.taskName) paths.taskName = metadata.taskName;
}
async function writeBridgeConfig(paths, options) {
  const existing = await readOptional(paths.bridgeConfig);
  let value = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
    } catch {
      throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON");
    }
  }
  value.host = options.host || value.host || DEFAULT_HOST;
  value.port = options.port || value.port || DEFAULT_PORT;
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new LifecycleError("port_invalid", "port must be an integer from 1 through 65535");
  value.token_file = servicePath(paths.token);
  value.max_input_bytes = value.max_input_bytes || 16 * 1024;
  await writeAtomic(paths.bridgeConfig, `${JSON.stringify(value, null, 2)}
`);
}
async function writeToken(paths, source) {
  if (await readOptional(paths.token)) return;
  const value = source ? (await readFile2(hostPath(source), "utf8")).trim() : randomBytes(32).toString("hex");
  if (!value) throw new LifecycleError("token_invalid", "token file is empty");
  await writeAtomic(paths.token, `${value}
`);
}
async function installUnit(paths) {
  const ownership = await unitOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("unit_owned_elsewhere", `service unit already exists and is not owned by this installation: ${paths.unit}`);
  await writeAtomic(paths.unit, unitContent(paths));
  if (platform2() === "win32" || process.env.CODEX_ORCHESTRATION_HOME) {
    await run("systemctl", ["--user", "link", servicePath(paths.unit)]);
    await run("systemctl", ["--user", "daemon-reload"]);
  } else {
    await run("systemctl", ["--user", "daemon-reload"]);
  }
}
async function installWindowsTask(paths) {
  if (platform2() !== "win32") return;
  const ownership = await taskOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  await writeAtomic(paths.launcher, windowsLauncher(paths), 448);
  const identity = await runHost("whoami.exe", ["/user"]);
  const userSid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!userSid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  await writeAtomic(paths.taskXml, Buffer.from(`\uFEFF${taskXml(paths, userSid)}`, "utf16le"));
  await runHost("schtasks.exe", ["/Create", "/TN", paths.taskName, "/XML", paths.taskXml, "/F"]);
  await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"]);
}
async function removeOwnedUnitLink(paths) {
  if (platform2() !== "win32" && !process.env.CODEX_ORCHESTRATION_HOME) return;
  const unit = servicePath(paths.unit);
  const linkName = paths.serviceName;
  const script = [
    "set -eu",
    `link="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${linkName}"`,
    `unit=${quoteShell(unit)}`,
    'if [ -L "$link" ]; then',
    '  if target=$(readlink -- "$link"); then',
    '    [ "$target" = "$unit" ] && rm -- "$link"',
    "  fi",
    "fi",
    ""
  ].join("\n");
  await run("bash", ["-lc", script], true);
}
async function stageRelease(paths, executable, version) {
  const source = await validateExecutable(executable);
  const targetRoot = join2(paths.releasesRoot, version);
  const target = join2(targetRoot, "symphony");
  try {
    await stat2(target);
    throw new LifecycleError("release_exists", `release ${version} already exists`);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if (error.code !== "ENOENT") throw new LifecycleError("release_invalid", `could not inspect release ${version}`);
  }
  await ensureDirectory(targetRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await copyFile(source, temporary);
  if (platform2() !== "win32") await chmod(temporary, 493);
  await rename(temporary, target);
  const old = await readOptional(paths.currentRelease);
  if (old) await writeAtomic(paths.previousRelease, `${old}
`);
  await writeAtomic(paths.currentRelease, `${servicePath(target)}
`);
}
async function ensureConfigEnv(paths) {
  process.env.CODEX_ORCHESTRATION_CONFIG = paths.bridgeConfig;
}
async function serviceStatus(paths, action) {
  const result = await run("systemctl", ["--user", action, paths.serviceName], true);
  return result.code === 0;
}
function requestId(operation) {
  return `cli-${operation}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}
async function managedControl(paths, operation, disable) {
  await ensureConfigEnv(paths);
  const client = await ManagedClient.fromConfig();
  let state;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      state = await client.state();
      break;
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "upstream_unreachable" || attempt === 49) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  if (!state || !Number.isInteger(state.revision)) throw new LifecycleError("state_invalid", "managed state did not include a current revision");
  return client.control({ request_id: requestId(operation), operation, args: { expected_revision: state.revision, disable } });
}
async function setup(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  for (const path of [paths.configRoot, paths.dataRoot, paths.stateRoot, paths.releasesRoot, paths.logsRoot, paths.journalRoot, paths.workspacesRoot, dirname2(paths.unit), dirname2(paths.wrapper)]) await ensureDirectory(path);
  if (options.workflow) {
    const source = hostPath(options.workflow);
    await access(source, constants.R_OK);
    await writeAtomic(paths.workflow, await readFile2(source, "utf8"));
  } else if (!await readOptional(paths.workflow)) {
    throw new LifecycleError("workflow_missing", `provide --workflow or create ${paths.workflow}`);
  }
  await writeToken(paths, options.tokenFile);
  await writeBridgeConfig(paths, options);
  if (options.executable) await stageRelease(paths, options.executable, validateVersion(options.version));
  if (!await readOptional(paths.currentRelease)) throw new LifecycleError("release_missing", "provide --executable to install the first managed release");
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile2(paths.bridgeConfig, "utf8")).port)), 448);
  if (platform2() === "win32") {
    const metadata = await readMetadata(paths);
    if (metadata.serviceName === paths.serviceName && metadata.taskName) paths.taskName = metadata.taskName;
    const ownership = await taskOwnership(paths);
    if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  }
  await installUnit(paths);
  if (platform2() === "win32") {
    await installWindowsTask(paths);
  }
  await writeAtomic(paths.metadata, `${JSON.stringify({ serviceName: paths.serviceName, taskName: paths.taskName, installedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`);
  return paths;
}
async function diagnostics(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  await ensureConfigEnv(paths);
  const config = await Promise.resolve().then(() => (init_config(), config_exports)).then(({ validateConfig: validateConfig2 }) => validateConfig2());
  return {
    valid: config.valid,
    config,
    service: { name: paths.serviceName, active: await serviceStatus(paths, "is-active"), enabled: await serviceStatus(paths, "is-enabled") },
    paths: { config: paths.bridgeConfig, workflow: paths.workflow, data: paths.dataRoot, state: paths.stateRoot, journal: paths.journalRoot, workspaces: paths.workspacesRoot, lock: paths.lock, unit: paths.unit },
    release: await readOptional(paths.currentRelease),
    previousRelease: await readOptional(paths.previousRelease),
    task: platform2() === "win32" ? paths.taskName : void 0
  };
}
async function start(options = {}) {
  applyOptions(options);
  const paths = await setup(options);
  await run("systemctl", ["--user", "enable", "--now", paths.serviceName]);
  if (platform2() === "win32") {
    await writeAtomic(paths.enabledMarker, "enabled\n");
    await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/ENABLE"]);
    await runHost("schtasks.exe", ["/Run", "/TN", paths.taskName]);
  }
  await managedControl(paths, "resume", false);
  return paths;
}
async function pause(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  return managedControl(paths, "pause", false);
}
async function resume(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  return managedControl(paths, "resume", false);
}
async function stop(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  await managedControl(paths, "pause", true);
  if (platform2() === "win32") await rm(paths.enabledMarker, { force: true });
  await run("systemctl", ["--user", "disable", "--now", paths.serviceName]);
  if (platform2() === "win32") await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"]);
  return paths;
}
async function upgrade(options) {
  if (!options.executable) throw new LifecycleError("executable_required", "upgrade requires --executable");
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  const version = validateVersion(options.version);
  await stageRelease(paths, options.executable, version);
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile2(paths.bridgeConfig, "utf8")).port)), 448);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}
async function rollback(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  const previous = await readOptional(paths.previousRelease);
  const current = await readOptional(paths.currentRelease);
  if (!previous || !current) throw new LifecycleError("rollback_unavailable", "no previous release is available for rollback");
  await writeAtomic(paths.currentRelease, `${previous}
`);
  await writeAtomic(paths.previousRelease, `${current}
`);
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile2(paths.bridgeConfig, "utf8")).port)), 448);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}
async function uninstall(options = {}) {
  applyOptions(options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  const unit = await unitOwnership(paths);
  const task = await taskOwnership(paths);
  if (unit === "foreign") throw new LifecycleError("unit_owned_elsewhere", `service unit exists and is not owned by this installation: ${paths.unit}`);
  if (task === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task exists and is not owned by this installation: ${paths.taskName}`);
  const owned = unit === "owned" || task === "owned";
  if (unit === "owned") {
    if (await serviceStatus(paths, "is-active")) await stop(options);
    await run("systemctl", ["--user", "disable", "--now", paths.serviceName], true);
    await removeOwnedUnitLink(paths);
  }
  if (task === "owned") {
    await rm(paths.enabledMarker, { force: true });
    await runHost("schtasks.exe", ["/Delete", "/TN", paths.taskName, "/F"], true);
  }
  if (owned) {
    for (const path of [paths.unit, paths.wrapper, paths.launcher, paths.taskXml, paths.metadata]) await rm(path, { force: true });
    await run("systemctl", ["--user", "daemon-reload"], true);
  }
  return paths;
}

// src/cli.ts
var usage = `Usage:
  codex-orchestration validate-config
  codex-orchestration diagnostics [--root PATH] [--service-name NAME]
  codex-orchestration setup --executable PATH --workflow PATH [--version VERSION] [--port PORT]
  codex-orchestration start [setup options]
  codex-orchestration pause | resume | stop | rollback | uninstall
  codex-orchestration upgrade --executable PATH [--version VERSION]`;
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
function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
try {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "validate-config") {
    const diagnostic = await validateConfig();
    print(diagnostic);
    process.exitCode = diagnostic.valid ? 0 : 1;
  } else if (command === "help") {
    console.log(usage);
    process.exitCode = 0;
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
    else throw new LifecycleError("usage", `unknown command: ${command}
${usage}`);
  }
} catch (error) {
  const lifecycle = error instanceof LifecycleError ? error : new LifecycleError("lifecycle_error", "The orchestration lifecycle command failed");
  console.error(`${lifecycle.code}: ${lifecycle.message}`);
  process.exitCode = lifecycle.code === "usage" ? 2 : 1;
}
