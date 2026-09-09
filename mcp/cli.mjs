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
import { resolve as resolve2, win32 } from "node:path";
function toWslPath(input) {
  const absolute = win32.resolve(input);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) throw new Error("plugin path must be on a local Windows drive");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}
function toWslServicePath(input) {
  if (input.startsWith("/")) return input;
  return toWslPath(input);
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
import { readFile as readFile2, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname as dirname2, isAbsolute as isAbsolute2, join, resolve as resolve3 } from "node:path";
function configFilePath() {
  const explicit = process.env.CODEX_ORCHESTRATION_CONFIG;
  if (explicit?.trim()) return resolve3(explicit);
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
    value = JSON.parse(await readFile2(path, "utf8"));
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
  const tokenFile = platform() === "win32" && /^\/mnt\/[A-Za-z]\//.test(token) ? fromWslPath(token) : isAbsolute2(token) ? resolve3(token) : resolve3(dirname2(path), token);
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
    const token = (await readFile2(config.tokenFile, "utf8")).trim();
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

// src/checkout.ts
import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
var execFile = promisify(nodeExecFile);
var CONTEXT_MAX_BYTES = 16 * 1024;
var INPUT_MAX_BYTES = 64 * 1024;
var REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;
var ATTEMPT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
var CheckoutError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
};
function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function invalid(code, message) {
  throw new CheckoutError(code, message);
}
function repositoryName(value) {
  if (typeof value === "string") return value;
  if (!plainObject(value)) return void 0;
  for (const key of ["name_with_owner", "nameWithOwner", "full_name", "fullName"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return void 0;
}
function contextRepository(context) {
  if (!plainObject(context.native_ref)) invalid("context_repository_missing", "issue context does not include a repository reference");
  const nativeRef = context.native_ref;
  const repository = repositoryName(nativeRef.repository) ?? repositoryName(nativeRef);
  if (!repository || !REPOSITORY_PATTERN.test(repository)) invalid("context_repository_invalid", "issue context repository reference is invalid");
  return repository;
}
function parseContext(raw) {
  if (Buffer.byteLength(raw, "utf8") > CONTEXT_MAX_BYTES) invalid("context_too_large", "issue context exceeds 16384 bytes");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("context_invalid", "issue context is not valid JSON");
  }
  if (!plainObject(value) || typeof value.id !== "string" || value.id.trim() === "" || typeof value.identifier !== "string" || value.identifier.trim() === "") {
    invalid("context_invalid", "issue context must include id and identifier");
  }
  return { id: value.id, identifier: value.identifier, native_ref: value.native_ref };
}
function readIssueContext(raw = process.env.SYMPHONY_ISSUE_CONTEXT) {
  if (!raw?.trim()) invalid("context_missing", "SYMPHONY_ISSUE_CONTEXT is required");
  return parseContext(raw);
}
async function readJsonFile(path, maxBytes, code) {
  let contents;
  try {
    contents = await readFile(path);
  } catch {
    invalid(`${code}_unreadable`, "checkout input could not be read");
  }
  if (contents.byteLength > maxBytes) invalid(`${code}_too_large`, "checkout input exceeds its size limit");
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    invalid(`${code}_invalid`, "checkout input is not valid JSON");
  }
}
function parseInput(value) {
  if (!plainObject(value) || typeof value.assignment_id !== "string" || value.assignment_id.trim() === "" || typeof value.attempt_id !== "string" || value.attempt_id.trim() === "" || typeof value.base_commit !== "string" || typeof value.workspace !== "string") {
    invalid("input_invalid", "checkout input must include assignment_id, attempt_id, base_commit, and workspace");
  }
  if (value.repository !== void 0 && typeof value.repository !== "string") invalid("input_invalid", "checkout repository must be a string");
  if (!ATTEMPT_PATTERN.test(value.attempt_id)) invalid("input_invalid", "checkout attempt_id is invalid");
  return {
    assignment_id: value.assignment_id,
    attempt_id: value.attempt_id,
    repository: value.repository,
    base_commit: value.base_commit,
    workspace: value.workspace
  };
}
function parseRemote(value) {
  if (!plainObject(value) || typeof value.remote !== "string" || value.remote.trim() === "") invalid("policy_invalid", "repository policy must provide a remote");
  const remote = value.remote.trim();
  if (/\s|[\u0000-\u001f]/.test(remote)) invalid("policy_invalid", "repository policy remote is invalid");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      if (!["https:", "ssh:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid("policy_invalid", "repository policy remote is invalid");
    } catch {
      invalid("policy_invalid", "repository policy remote is invalid");
    }
  } else if (!/^git@[A-Za-z0-9._-]+:[^\s]+$/.test(remote)) {
    invalid("policy_invalid", "repository policy remote is invalid");
  }
  return { remote };
}
function parsePolicy(value) {
  if (!plainObject(value) || typeof value.workspace_root !== "string" || !isAbsolute(value.workspace_root) || typeof value.control_root !== "string" || !isAbsolute(value.control_root) || !plainObject(value.repositories)) {
    invalid("policy_invalid", "checkout policy must include absolute control_root, workspace_root, and repositories");
  }
  const repositories = {};
  for (const [name, repository] of Object.entries(value.repositories)) {
    if (!REPOSITORY_PATTERN.test(name)) invalid("policy_invalid", "checkout policy contains an invalid repository name");
    repositories[name.toLowerCase()] = parseRemote(repository);
  }
  if (Object.keys(repositories).length === 0) invalid("policy_invalid", "checkout policy must allow at least one repository");
  return { control_root: value.control_root, workspace_root: value.workspace_root, repositories };
}
function inside(root, target) {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function resolveWorkspace(rootInput, workspaceInput) {
  if (!isAbsolute(workspaceInput) || workspaceInput.includes("\0")) invalid("workspace_invalid", "workspace must be an absolute path");
  let root;
  try {
    root = await realpath(rootInput);
  } catch {
    invalid("workspace_root_invalid", "checkout workspace_root does not exist");
  }
  const rawWorkspace = resolve(workspaceInput);
  let workspace;
  let exists;
  try {
    const details = await lstat(rawWorkspace);
    if (details.isSymbolicLink()) invalid("workspace_invalid", "workspace must not be a symbolic link");
    if (!details.isDirectory()) invalid("workspace_invalid", "workspace must be a directory");
    workspace = await realpath(rawWorkspace);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    let parent;
    try {
      parent = await realpath(dirname(rawWorkspace));
    } catch {
      invalid("workspace_invalid", "workspace parent does not exist");
    }
    workspace = resolve(parent, basename(rawWorkspace));
    exists = false;
  }
  if (!inside(root, workspace)) invalid("workspace_outside_root", "workspace is outside the trusted workspace_root");
  if (!exists) {
    const parent = dirname(workspace);
    if (!inside(root, parent) && parent !== root) invalid("workspace_outside_root", "workspace parent is outside the trusted workspace_root");
  }
  return { root, workspace, exists };
}
async function gitResult(args, cwd) {
  try {
    const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1048576, windowsHide: true });
    return { code: 0, stdout: result.stdout.trim() };
  } catch {
    return { code: 1, stdout: "" };
  }
}
async function git(args, cwd) {
  const result = await gitResult(args, cwd);
  if (result.code !== 0) invalid("git_failed", `git ${args[0] || "command"} failed`);
  return result.stdout;
}
function sameRemote(actual, expected) {
  return actual.trim().replace(/\/$/, "") === expected.trim().replace(/\/$/, "");
}
async function prepareExisting(workspace, remote) {
  const entries = await readdir(workspace);
  if (entries.length === 0) {
    await git(["clone", "--no-checkout", "--origin", "origin", remote, workspace]);
    return true;
  }
  if (await git(["rev-parse", "--is-inside-work-tree"], workspace) !== "true") invalid("workspace_invalid", "workspace is not a Git worktree");
  const top = resolve(await git(["rev-parse", "--show-toplevel"], workspace));
  if (top !== resolve(workspace)) invalid("workspace_invalid", "workspace is not the checkout root");
  const actualRemote = await git(["remote", "get-url", "origin"], workspace);
  if (!sameRemote(actualRemote, remote)) invalid("repository_mismatch", "workspace origin does not match the enrolled repository");
  return false;
}
async function requireBaseCommit(workspace, baseCommit) {
  const result = await gitResult(["cat-file", "-e", `${baseCommit}^{commit}`], workspace);
  if (result.code !== 0) invalid("base_commit_unavailable", "requested base commit is not present in the checkout");
}
async function validateInputLocation(inputFile, policy, workspaceRoot) {
  let controlRoot;
  let inputPath;
  let inputParent;
  try {
    controlRoot = await realpath(policy.control_root);
    inputPath = resolve(inputFile);
    const details = await lstat(inputPath);
    if (details.isSymbolicLink() || !details.isFile()) invalid("input_location_invalid", "checkout input must be a regular file");
    inputParent = await realpath(dirname(inputPath));
  } catch {
    invalid("input_location_invalid", "checkout input location could not be inspected");
  }
  if (!insideOrSelf(controlRoot, inputParent)) invalid("input_location_invalid", "checkout input is outside the trusted control_root");
  if (insideOrSelf(workspaceRoot, inputParent)) invalid("input_location_invalid", "checkout input must be outside the worker workspace");
}
function insideOrSelf(root, target) {
  return root === target || inside(root, target);
}
async function prepareTrustedCheckout(options) {
  if (!options.inputFile?.trim()) invalid("input_missing", "checkout requires a per-attempt input file");
  const context = readIssueContext(options.context);
  const input = parseInput(await readJsonFile(options.inputFile, INPUT_MAX_BYTES, "input"));
  const policyPath = options.policyFile?.trim() || process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY?.trim();
  if (!policyPath) invalid("policy_missing", "checkout requires CODEX_ORCHESTRATION_CHECKOUT_POLICY or --policy");
  const policy = parsePolicy(await readJsonFile(policyPath, INPUT_MAX_BYTES, "policy"));
  const contextRepo = contextRepository(context);
  if (input.assignment_id !== context.id) invalid("assignment_mismatch", "checkout assignment_id does not match issue context");
  const repository = input.repository || contextRepo;
  if (!REPOSITORY_PATTERN.test(repository)) invalid("repository_invalid", "repository must use OWNER/REPOSITORY form");
  if (repository.toLowerCase() !== contextRepo.toLowerCase()) invalid("repository_mismatch", "checkout repository does not match issue context");
  const configured = policy.repositories[repository.toLowerCase()];
  if (!configured) invalid("repository_not_enrolled", "repository is not in the trusted checkout policy");
  if (!COMMIT_PATTERN.test(input.base_commit)) invalid("base_commit_invalid", "base_commit must be a full Git commit SHA");
  const workspace = await resolveWorkspace(policy.workspace_root, input.workspace);
  await validateInputLocation(options.inputFile, policy, workspace.root);
  let cloned = false;
  try {
    if (workspace.exists) {
      cloned = await prepareExisting(workspace.workspace, configured.remote);
    } else {
      await mkdir(dirname(workspace.workspace), { recursive: true });
      await git(["clone", "--no-checkout", "--origin", "origin", configured.remote, workspace.workspace]);
      cloned = true;
    }
    await requireBaseCommit(workspace.workspace, input.base_commit);
    if (cloned) {
      await git(["checkout", "--detach", "--force", input.base_commit], workspace.workspace);
    } else {
      const current = await git(["rev-parse", "HEAD"], workspace.workspace);
      if (current.toLowerCase() !== input.base_commit.toLowerCase() && (await gitResult(["merge-base", "--is-ancestor", input.base_commit, current], workspace.workspace)).code !== 0) {
        invalid("base_commit_mismatch", "existing checkout is not based on the enrolled base commit");
      }
    }
    const head = await git(["rev-parse", "HEAD"], workspace.workspace);
    if (cloned && head.toLowerCase() !== input.base_commit.toLowerCase()) invalid("checkout_failed", "checkout did not reach the requested base commit");
  } catch (error) {
    if (cloned) await rm(workspace.workspace, { recursive: true, force: true }).catch(() => void 0);
    throw error;
  }
  return {
    issue_id: context.id,
    identifier: context.identifier,
    assignment_id: input.assignment_id,
    attempt_id: input.attempt_id,
    repository,
    base_commit: input.base_commit,
    workspace: workspace.workspace
  };
}

// src/lifecycle.ts
import { access, chmod, copyFile, lstat as lstat2, mkdir as mkdir2, readFile as readFile3, rename, rm as rm2, stat as stat2, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as nodeExecFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { homedir as homedir2, platform as platform2 } from "node:os";
import { dirname as dirname3, join as join2, resolve as resolve4, win32 as win322 } from "node:path";
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
init_config();
init_paths();
var execFile2 = promisify2(nodeExecFile2);
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
  const serviceIdentity = serviceName.replace(/\.service$/, "");
  if (!SERVICE_NAME_PATTERN.test(serviceIdentity) || serviceIdentity === "." || serviceIdentity === "..") {
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
  if (platform2() !== "win32" || !input.startsWith("/mnt/")) return resolve4(input);
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(input);
  if (!match) throw new LifecycleError("path_invalid", "WSL path must use a local mounted Windows drive");
  return win322.resolve(`${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`);
}
function servicePath(input) {
  return platform2() === "win32" ? toWslServicePath(input) : input;
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
    const result = await execFile2(actualCommand, actualArgs, { windowsHide: true, maxBuffer: 1048576 });
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
function wslOptionPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) ? toWslPath(value) : value;
}
function delegatedOptionArgs(options) {
  const args = [];
  const values = [
    ["--executable", options.executable, true],
    ["--workflow", options.workflow, true],
    ["--version", options.version, false],
    ["--host", options.host, false],
    ["--port", options.port === void 0 ? void 0 : String(options.port), false],
    ["--token-file", options.tokenFile, true],
    ["--root", options.root, true],
    ["--service-name", options.serviceName, false]
  ];
  for (const [name, value, path] of values) {
    if (value === void 0) continue;
    args.push(name, path ? wslOptionPath(value) : value);
  }
  return args;
}
async function resolveWslNode() {
  const result = await runHost("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node -p process.execPath"], true);
  if (result.code !== 0) throw new LifecycleError("wsl_node_missing", "could not resolve a Linux Node runtime in Ubuntu WSL");
  const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/(?!mnt\/)[^\r\n]+\/node$/.test(line)).pop();
  if (!candidate) throw new LifecycleError("wsl_node_missing", "Ubuntu WSL did not return a Linux Node runtime");
  return candidate;
}
async function runWslCli(command, options = {}) {
  const scriptInput = process.argv[1] || resolve4("mcp/cli.mjs");
  const script = scriptInput.startsWith("/") ? scriptInput : wslOptionPath(resolve4(scriptInput));
  const node = await resolveWslNode();
  const unset = [
    "CODEX_ORCHESTRATION_CONFIG",
    "CODEX_ORCHESTRATION_HOME",
    "CODEX_ORCHESTRATION_SERVICE_NAME",
    "CODEX_ORCHESTRATION_TASK_NAME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME"
  ];
  const environment = ["env", ...unset.flatMap((name) => ["-u", name])];
  const inherited = /* @__PURE__ */ new Map([
    ["CODEX_ORCHESTRATION_HOME", options.root || process.env.CODEX_ORCHESTRATION_HOME],
    ["CODEX_ORCHESTRATION_CONFIG", process.env.CODEX_ORCHESTRATION_CONFIG],
    ["CODEX_ORCHESTRATION_SERVICE_NAME", options.serviceName || process.env.CODEX_ORCHESTRATION_SERVICE_NAME],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME],
    ["XDG_DATA_HOME", process.env.XDG_DATA_HOME],
    ["XDG_STATE_HOME", process.env.XDG_STATE_HOME]
  ]);
  for (const [name, value] of inherited) {
    if (value) environment.push(`${name}=${name.startsWith("XDG_") || name.endsWith("_HOME") || name.endsWith("_CONFIG") ? wslOptionPath(value) : value}`);
  }
  const result = await runHost("wsl.exe", ["-d", "Ubuntu", "--", ...environment, node, script, command, ...delegatedOptionArgs(options)], true);
  try {
    const value = JSON.parse(result.stdout);
    if (result.code !== 0 && command !== "validate-config") {
      const output = `${result.stderr}
${result.stdout}`.trim();
      throw new LifecycleError("delegated_failed", output.slice(0, 500) || `WSL ${command} failed`);
    }
    return value;
  } catch {
    if (result.code !== 0) {
      const output = `${result.stderr}
${result.stdout}`.trim();
      throw new LifecycleError("delegated_failed", output.slice(0, 500) || `WSL ${command} failed`);
    }
    throw new LifecycleError("delegated_invalid", `WSL ${command} returned invalid lifecycle JSON`);
  }
}
function windowsKeeperPaths(linuxPaths) {
  const home = process.env.USERPROFILE || homedir2();
  const configuredData = process.env.XDG_DATA_HOME?.trim();
  const dataBase = configuredData && /^[A-Za-z]:[\\/]/.test(configuredData) ? configuredData : join2(home, ".local", "share");
  const service = linuxPaths.serviceName.replace(/\.service$/, "");
  const root = join2(dataBase, "codex-orchestration", service);
  return {
    ...linuxPaths,
    launcher: join2(root, "bin", "windows-launcher.ps1"),
    taskXml: join2(root, "bin", "windows-task.xml"),
    metadata: join2(root, "installation.json"),
    taskName: `Codex-Orchestration-${randomBytes(4).toString("hex")}`
  };
}
async function writeLinuxMarker(path) {
  await run("mkdir", ["-p", dirname3(path)]);
  await run("sh", ["-lc", `umask 077; printf '%s\\n' enabled > ${quoteShell(path)}`]);
}
async function removeLinuxMarker(path) {
  await run("rm", ["-f", path], true);
}
async function ensureDirectory(path) {
  await mkdir2(path, { recursive: true });
  if (platform2() !== "win32") await chmod(path, 448);
}
async function writeAtomic(path, content, mode = 384) {
  await ensureDirectory(dirname3(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode });
  if (platform2() !== "win32") await chmod(temp, mode);
  await rename(temp, path);
}
async function readOptional(path) {
  try {
    return (await readFile3(path, "utf8")).trim() || void 0;
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
    `wsl.exe -d Ubuntu -- test -f ${powershellQuote(marker)}`,
    "if ($LASTEXITCODE -ne 0) { exit 0 }",
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
    details = await lstat2(paths.unit);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw new LifecycleError("unit_inspection_failed", `could not inspect service unit ${paths.unit}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) return "foreign";
  const content = await readFile3(paths.unit, "utf8");
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
  const value = source ? (await readFile3(hostPath(source), "utf8")).trim() : randomBytes(32).toString("hex");
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
async function setupWindows(options) {
  const linuxPaths = await runWslCli("setup", options);
  const paths = windowsKeeperPaths(linuxPaths);
  await applyStoredTaskName(paths);
  const ownership = await taskOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  await installWindowsTask(paths);
  await writeAtomic(paths.metadata, `${JSON.stringify({ serviceName: paths.serviceName, taskName: paths.taskName, installedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`);
  return paths;
}
async function setup(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") return setupWindows(options);
  const paths = lifecyclePaths(process.env, platform2());
  for (const path of [paths.configRoot, paths.dataRoot, paths.stateRoot, paths.releasesRoot, paths.logsRoot, paths.journalRoot, paths.workspacesRoot, dirname3(paths.unit), dirname3(paths.wrapper)]) await ensureDirectory(path);
  if (options.workflow) {
    const source = hostPath(options.workflow);
    await access(source, constants.R_OK);
    await writeAtomic(paths.workflow, await readFile3(source, "utf8"));
  } else if (!await readOptional(paths.workflow)) {
    throw new LifecycleError("workflow_missing", `provide --workflow or create ${paths.workflow}`);
  }
  await writeToken(paths, options.tokenFile);
  await writeBridgeConfig(paths, options);
  if (options.executable) await stageRelease(paths, options.executable, validateVersion(options.version));
  if (!await readOptional(paths.currentRelease)) throw new LifecycleError("release_missing", "provide --executable to install the first managed release");
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile3(paths.bridgeConfig, "utf8")).port)), 448);
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
async function validateConfigForHost() {
  if (platform2() === "win32") return await runWslCli("validate-config");
  return validateConfig();
}
async function diagnostics(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") return await runWslCli("diagnostics", options);
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
  if (platform2() === "win32") {
    const paths2 = await setupWindows(options);
    await run("systemctl", ["--user", "enable", "--now", paths2.serviceName]);
    await writeLinuxMarker(paths2.enabledMarker);
    await runHost("schtasks.exe", ["/Change", "/TN", paths2.taskName, "/ENABLE"]);
    await runHost("schtasks.exe", ["/Run", "/TN", paths2.taskName]);
    await runWslCli("resume", options);
    return paths2;
  }
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
  if (platform2() === "win32") return runWslCli("pause", options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  return managedControl(paths, "pause", false);
}
async function resume(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") return runWslCli("resume", options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  return managedControl(paths, "resume", false);
}
async function stop(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") {
    const probe = windowsKeeperPaths(lifecyclePaths(process.env, platform2()));
    await applyStoredTaskName(probe);
    const result = await runWslCli("stop", options);
    await removeLinuxMarker(result.enabledMarker);
    const paths2 = windowsKeeperPaths(result);
    paths2.taskName = probe.taskName;
    await runHost("schtasks.exe", ["/Change", "/TN", paths2.taskName, "/DISABLE"], true);
    return paths2;
  }
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  await managedControl(paths, "pause", true);
  if (platform2() === "win32") await rm2(paths.enabledMarker, { force: true });
  await run("systemctl", ["--user", "disable", "--now", paths.serviceName]);
  if (platform2() === "win32") await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"]);
  return paths;
}
async function upgrade(options) {
  if (!options.executable) throw new LifecycleError("executable_required", "upgrade requires --executable");
  applyOptions(options);
  if (platform2() === "win32") return await runWslCli("upgrade", options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  const version = validateVersion(options.version);
  await stageRelease(paths, options.executable, version);
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile3(paths.bridgeConfig, "utf8")).port)), 448);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}
async function rollback(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") return await runWslCli("rollback", options);
  const paths = lifecyclePaths(process.env, platform2());
  await applyStoredTaskName(paths);
  const previous = await readOptional(paths.previousRelease);
  const current = await readOptional(paths.currentRelease);
  if (!previous || !current) throw new LifecycleError("rollback_unavailable", "no previous release is available for rollback");
  await writeAtomic(paths.currentRelease, `${previous}
`);
  await writeAtomic(paths.previousRelease, `${current}
`);
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile3(paths.bridgeConfig, "utf8")).port)), 448);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}
async function uninstall(options = {}) {
  applyOptions(options);
  if (platform2() === "win32") {
    const probe = windowsKeeperPaths(lifecyclePaths(process.env, platform2()));
    await applyStoredTaskName(probe);
    const task2 = await taskOwnership(probe);
    if (task2 === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${probe.taskName}`);
    const result = await runWslCli("uninstall", options);
    await removeLinuxMarker(result.enabledMarker);
    if (task2 === "owned") await runHost("schtasks.exe", ["/Delete", "/TN", probe.taskName, "/F"], true);
    for (const path of [probe.launcher, probe.taskXml, probe.metadata]) await rm2(path, { force: true });
    return { ...result, launcher: probe.launcher, taskXml: probe.taskXml, metadata: probe.metadata, taskName: probe.taskName };
  }
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
    await rm2(paths.enabledMarker, { force: true });
    await runHost("schtasks.exe", ["/Delete", "/TN", paths.taskName, "/F"], true);
  }
  if (owned) {
    for (const path of [paths.unit, paths.wrapper, paths.launcher, paths.taskXml, paths.metadata]) await rm2(path, { force: true });
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
  codex-orchestration upgrade --executable PATH [--version VERSION]
  codex-orchestration checkout --input PATH [--policy PATH]`;
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
function parseCheckoutOptions(values) {
  let inputFile;
  let policyFile;
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (name === "--help") throw new CheckoutError("usage", usage);
    if (name !== "--input" && name !== "--policy") throw new CheckoutError("usage", `unknown option: ${name}`);
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new CheckoutError("usage", `${name} requires a value`);
    if (name === "--input") inputFile = value;
    else policyFile = value;
  }
  if (!inputFile) throw new CheckoutError("usage", "checkout requires --input PATH");
  return { inputFile, policyFile };
}
function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
try {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "validate-config") {
    const diagnostic = await validateConfigForHost();
    print(diagnostic);
    process.exitCode = diagnostic.valid ? 0 : 1;
  } else if (command === "help") {
    console.log(usage);
    process.exitCode = 0;
  } else if (command === "checkout") {
    print(await prepareTrustedCheckout(parseCheckoutOptions(args)));
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
  const lifecycle = error instanceof LifecycleError || error instanceof CheckoutError ? error : new LifecycleError("lifecycle_error", "The orchestration lifecycle command failed");
  console.error(`${lifecycle.code}: ${lifecycle.message}`);
  process.exitCode = lifecycle.code === "usage" ? 2 : 1;
}
