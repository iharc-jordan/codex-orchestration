import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { captureControllerEnvironment, LifecycleError } from "./lifecycle.js";
import { orchestrationPaths } from "./paths.js";

const execFile = promisify(execFileCallback);
const TASK_PREFIX = "Codex-Orchestration-Lifecycle-";
const TASK_DEADLINE_MS = 180_000;
const RESULT_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_MAX_BYTES = 1024 * 1024;
const MUTATIONS = new Set(["setup", "start", "pause", "resume", "stop", "upgrade", "rollback", "uninstall"]);

type TaskRequest = {
  schemaVersion: 1;
  nonce: string;
  operation: string;
  args: string[];
  userSid: string;
  deadlineAt: number;
  root: string;
  controllerEnvironment: Record<string, string>;
};

type TaskResult = {
  schemaVersion: 1;
  nonce: string;
  operation: string;
  exitCode: number;
  requestFinalPath: string;
  root: string;
  rootFinalPath: string | null;
  configFinalPath: string | null;
  tokenFinalPath: string | null;
};

type TaskSnapshot = {
  exists: boolean;
  active?: boolean;
  userId?: string;
  execute?: string;
  arguments?: string;
  workingDirectory?: string;
};

type LifecycleDispatch = (operation: string, args: string[], deadlineAt: number) => Promise<unknown>;

export function isLifecycleMutation(command: string): boolean {
  return MUTATIONS.has(command);
}

/** A /Run request may have been accepted even when schtasks itself times out. */
export function lifecycleRunOutcomeIsUncertain(runRequested: boolean, resultValidated: boolean): boolean {
  return runRequested && !resultValidated;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

/** Quote one argv element according to the Windows CRT CommandLineToArgvW rules. */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s\"]/.test(value)) return value;
  let output = "\"";
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === "\"") {
      output += "\\".repeat(backslashes * 2 + 1) + "\"";
      backslashes = 0;
    } else {
      output += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return output + "\\".repeat(backslashes * 2) + "\"";
}

export function lifecycleTaskArguments(cli: string, request: string, nonce: string): string {
  return [cli, "--lifecycle-task-child", request, nonce].map(quoteWindowsArgument).join(" ");
}

export function lifecycleTaskXml(node: string, cli: string, request: string, nonce: string, userSid: string): string {
  const argumentsValue = lifecycleTaskArguments(cli, request, nonce);
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
    "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    "  <RegistrationInfo><Description>Codex Orchestration one-shot lifecycle " + xml(nonce) + "</Description></RegistrationInfo>",
    "  <Triggers />",
    "  <Principals><Principal id=\"Author\"><UserId>" + xml(userSid) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "  <Settings><Hidden>true</Hidden><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT4M</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
    "  <Actions Context=\"Author\"><Exec><Command>" + xml(node) + "</Command><Arguments>" + xml(argumentsValue) + "</Arguments><WorkingDirectory>" + xml(dirname(cli)) + "</WorkingDirectory></Exec></Actions>",
    "</Task>", ""
  ].join("\r\n");
}

async function command(executable: string, args: string[], allowFailure = false): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const detail = error as { code?: number | string; stdout?: string; stderr?: string };
    const code = typeof detail.code === "number" ? detail.code : 1;
    if (allowFailure) return { code, stdout: detail.stdout || "", stderr: detail.stderr || "" };
    const message = String(detail.stderr || detail.stdout || "").trim().slice(0, 500);
    throw new LifecycleError("lifecycle_task_command_failed", basename(executable) + " failed" + (message ? ": " + message : ""), code);
  }
}

async function currentSid(): Promise<string> {
  const result = await command("whoami.exe", ["/user"]);
  const sid = result.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  return sid;
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US");
}

async function regularFile(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  if (!isAbsolute(path)) throw new LifecycleError("lifecycle_task_invalid", label + " must be an absolute path");
  try {
    if (!(await stat(absolute)).isFile()) throw new Error("not a file");
    return absolute;
  } catch {
    throw new LifecycleError("lifecycle_task_invalid", label + " is not a regular file: " + absolute);
  }
}

async function privateInvocationDirectory(path: string, sid: string): Promise<void> {
  await mkdir(path, { recursive: false });
  const link = await lstat(path);
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

async function removeInvocationDirectory(path: string, bridgeRoot: string, nonce: string): Promise<void> {
  if (dirname(resolve(path)) !== resolve(bridgeRoot) || basename(path) !== nonce) {
    throw new LifecycleError("lifecycle_task_cleanup_failed", "lifecycle staging cleanup target escaped its owned root");
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new LifecycleError("lifecycle_task_cleanup_failed", "lifecycle staging cleanup target became a reparse-point link");
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomic(path: string, contents: string | Buffer): Promise<void> {
  const temporary = path + ".tmp-" + randomUUID();
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const details = await stat(path);
  if (!details.isFile() || details.size > maximum) throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task output is missing or exceeds its bounded size");
  return readFile(path);
}

function strictObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("lifecycle_task_result_invalid", label + " must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new LifecycleError("lifecycle_task_result_invalid", label + " contains an unexpected field");
  return record;
}

async function taskSnapshot(taskName: string): Promise<TaskSnapshot> {
  const safeName = taskName.replaceAll("'", "''");
  const script = [
    "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq '" + safeName + "' -and $_.TaskPath -eq '\\' })",
    "if ($tasks.Count -eq 0) { [Console]::WriteLine('{\"exists\":false}'); exit 0 }",
    "$task = $tasks[0]",
    "$action = @($task.Actions)[0]",
    "$state = [int]$task.State",
    "$principal = [string]$task.Principal.UserId",
    "$principalSid = if ($principal -match '^S-\\d-') { $principal } else { (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value }",
    "[Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ exists=$true; active=($state -eq 2 -or $state -eq 4); userId=$principalSid; execute=[string]$action.Execute; arguments=[string]$action.Arguments; workingDirectory=[string]$action.WorkingDirectory }))"
  ].join("; ");
  const result = await command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  try {
    const value = JSON.parse(result.stdout.trim()) as TaskSnapshot;
    if (typeof value.exists !== "boolean") throw new Error("invalid");
    return value;
  } catch {
    throw new LifecycleError("lifecycle_task_inspection_failed", "could not inspect the temporary lifecycle task");
  }
}

function verifiedSnapshot(snapshot: TaskSnapshot, node: string, expectedArguments: string, workingDirectory: string, userSid: string): boolean {
  return snapshot.exists === true
    && snapshot.userId?.toLocaleLowerCase("en-US") === userSid.toLocaleLowerCase("en-US")
    && typeof snapshot.execute === "string" && samePath(snapshot.execute, node)
    && snapshot.arguments === expectedArguments
    && typeof snapshot.workingDirectory === "string" && samePath(snapshot.workingDirectory, workingDirectory);
}

async function stopAndDeleteVerifiedTask(taskName: string, node: string, expectedArguments: string, workingDirectory: string, userSid: string): Promise<void> {
  let snapshot = await taskSnapshot(taskName);
  if (!snapshot.exists) return;
  if (!verifiedSnapshot(snapshot, node, expectedArguments, workingDirectory, userSid)) {
    throw new LifecycleError("lifecycle_task_identity_mismatch", "temporary lifecycle task identity changed; it was not stopped or deleted");
  }
  if (snapshot.active) {
    await command("schtasks.exe", ["/End", "/TN", taskName], true);
    const deadline = Date.now() + 10_000;
    do {
      await new Promise((done) => setTimeout(done, 100));
      snapshot = await taskSnapshot(taskName);
      if (!snapshot.exists || !snapshot.active) break;
    } while (Date.now() < deadline);
    if (snapshot.exists && snapshot.active) throw new LifecycleError("lifecycle_task_cleanup_uncertain", "temporary lifecycle task did not become inactive and was not deleted");
  }
  const removed = await command("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], true);
  if ((await taskSnapshot(taskName)).exists) {
    throw new LifecycleError("lifecycle_task_cleanup_failed", "temporary lifecycle task could not be deleted");
  }
  if (removed.code !== 0) return;
}

function parseResult(value: unknown, request: TaskRequest): TaskResult {
  const result = strictObject(value, ["schemaVersion", "nonce", "operation", "exitCode", "requestFinalPath", "root", "rootFinalPath", "configFinalPath", "tokenFinalPath"], "lifecycle task result");
  if (result.schemaVersion !== 1 || result.nonce !== request.nonce || result.operation !== request.operation || result.root !== request.root) {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task result did not match its request identity");
  }
  if (!Number.isInteger(result.exitCode) || Number(result.exitCode) < 0 || Number(result.exitCode) > 0xffff_ffff) {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task returned an invalid exit code");
  }
  if (typeof result.requestFinalPath !== "string"
    || (result.rootFinalPath !== null && typeof result.rootFinalPath !== "string")
    || (result.configFinalPath !== null && typeof result.configFinalPath !== "string")
    || (result.tokenFinalPath !== null && typeof result.tokenFinalPath !== "string")) {
    throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task omitted its physical-path evidence");
  }
  return result as TaskResult;
}

async function parseRequest(path: string, nonce: string): Promise<TaskRequest> {
  const bytes = await readBounded(path, REQUEST_MAX_BYTES);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request is not valid JSON"); }
  const raw = strictObject(value, ["schemaVersion", "nonce", "operation", "args", "userSid", "deadlineAt", "root", "controllerEnvironment"], "lifecycle task request");
  if (raw.schemaVersion !== 1 || raw.nonce !== nonce || typeof raw.operation !== "string" || !MUTATIONS.has(raw.operation)) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request identity or operation is invalid");
  }
  if (!Array.isArray(raw.args) || raw.args.some((entry) => typeof entry !== "string") || JSON.stringify(raw.args).length > 128 * 1024) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request arguments are invalid");
  }
  if (typeof raw.userSid !== "string" || !/^S-\d-\d+(?:-\d+)+$/.test(raw.userSid)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request SID is invalid");
  if (!Number.isSafeInteger(raw.deadlineAt) || Number(raw.deadlineAt) <= Date.now() || Number(raw.deadlineAt) > Date.now() + TASK_DEADLINE_MS + 10_000) {
    throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request deadline is invalid");
  }
  if (typeof raw.root !== "string" || !isAbsolute(raw.root)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request root is invalid");
  const environmentRaw = strictObject(raw.controllerEnvironment, Object.keys(raw.controllerEnvironment as Record<string, unknown>), "controller environment");
  if (Object.values(environmentRaw).some((entry) => typeof entry !== "string")) throw new LifecycleError("lifecycle_task_request_invalid", "controller environment values must be strings");
  const environment = captureControllerEnvironment(environmentRaw as NodeJS.ProcessEnv);
  if (Object.keys(environment).length !== Object.keys(environmentRaw).length) throw new LifecycleError("lifecycle_task_request_invalid", "controller environment contains a disallowed name");
  return { ...raw, args: raw.args as string[], deadlineAt: Number(raw.deadlineAt), controllerEnvironment: environment } as TaskRequest;
}

function lifecycleErrorText(error: unknown): { code: number; text: string } {
  if (error instanceof LifecycleError) return { code: error.code === "usage" ? 2 : 1, text: error.code + ": " + error.message };
  return { code: 1, text: "lifecycle_error: The orchestration lifecycle command failed" };
}

export async function runLifecycleTaskChild(requestPath: string, nonce: string, dispatch: LifecycleDispatch, testRoot?: string): Promise<number> {
  const absoluteRequest = resolve(requestPath);
  const invocation = dirname(absoluteRequest);
  const stdoutPath = join(invocation, "stdout.txt");
  const stderrPath = join(invocation, "stderr.txt");
  const resultPath = join(invocation, "result.json");
  let request: TaskRequest | undefined;
  let exitCode = 1;
  let output = "";
  let errorOutput = "";
  let rootFinalPath: string | null = null;
  let configFinalPath: string | null = null;
  let tokenFinalPath: string | null = null;
  let requestFinalPath = absoluteRequest;
  try {
    request = await parseRequest(absoluteRequest, nonce);
    const fixedRoot = orchestrationPaths(process.env, testRoot).root;
    if (!samePath(request.root, fixedRoot)) throw new LifecycleError("lifecycle_task_request_invalid", "private lifecycle request root is not the fixed orchestration root");
    if ((await currentSid()).toLocaleLowerCase("en-US") !== request.userSid.toLocaleLowerCase("en-US")) {
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
  await atomic(stdoutPath, output);
  await atomic(stderrPath, errorOutput);
  const result: TaskResult = {
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
  await atomic(resultPath, JSON.stringify(result));
  return exitCode;
}

export async function runLifecycleViaTask(cliInput: string, argv: string[], testRoot?: string): Promise<number> {
  if (process.platform !== "win32") throw new LifecycleError("platform_unsupported", "Codex Orchestration lifecycle commands require Windows");
  const operation = argv[0] || "";
  if (!MUTATIONS.has(operation)) throw new LifecycleError("lifecycle_task_invalid", "only lifecycle mutations can use the one-shot task boundary");
  const cli = await regularFile(cliInput, "CLI entrypoint");
  const node = await regularFile(process.execPath, "Node executable");
  if (basename(node).toLocaleLowerCase("en-US") !== "node.exe") throw new LifecycleError("lifecycle_task_invalid", "lifecycle task requires the public node.exe entrypoint");
  const pluginRoot = dirname(dirname(cli));
  await regularFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "plugin manifest");
  const userProfile = process.env.USERPROFILE?.trim();
  if (!userProfile || !isAbsolute(userProfile)) throw new LifecycleError("lifecycle_task_invalid", "USERPROFILE must be an absolute Windows path");
  const sid = await currentSid();
  const nonce = randomUUID().replaceAll("-", "");
  const taskName = TASK_PREFIX + nonce;
  const bridgeRoot = join(resolve(userProfile), ".codex", "orchestration-lifecycle");
  await mkdir(bridgeRoot, { recursive: true });
  const invocation = join(bridgeRoot, nonce);
  const requestPath = join(invocation, "request.json");
  const resultPath = join(invocation, "result.json");
  const stdoutPath = join(invocation, "stdout.txt");
  const stderrPath = join(invocation, "stderr.txt");
  const taskXmlPath = join(invocation, "task.xml");
  const deadlineAt = Date.now() + TASK_DEADLINE_MS;
  const expectedRoot = orchestrationPaths(process.env, testRoot).root;
  const request: TaskRequest = {
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
    await atomic(requestPath, JSON.stringify(request));
    await atomic(taskXmlPath, Buffer.from("\uFEFF" + lifecycleTaskXml(node, cli, requestPath, nonce, sid), "utf16le"));
  } catch (error) {
    await removeInvocationDirectory(invocation, bridgeRoot, nonce);
    throw error;
  }

  let createAttempted = false;
  let created = false;
  let runRequested = false;
  let resultValidated = false;
  let preserveInvocation = false;
  let pendingError: unknown;
  let taskResult: TaskResult | undefined;
  let stdout = "";
  let stderr = "";
  try {
    createAttempted = true;
    await command("schtasks.exe", ["/Create", "/TN", taskName, "/XML", taskXmlPath, "/F"]);
    created = true;
    const before = await taskSnapshot(taskName);
    if (!verifiedSnapshot(before, node, expectedArguments, dirname(cli), sid)) {
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
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!taskResult) throw new LifecycleError("lifecycle_outcome_uncertain", "temporary lifecycle task exceeded its absolute deadline; it will not be replayed");
    const requestFinalPath = realpathSync.native(requestPath);
    if (!samePath(taskResult.requestFinalPath, requestFinalPath)) throw new LifecycleError("lifecycle_task_result_invalid", "lifecycle task result did not attest the private request path");
    if (taskResult.exitCode === 0) {
      const resolvedPaths = orchestrationPaths(process.env, testRoot);
      if (!taskResult.rootFinalPath || !taskResult.configFinalPath || !taskResult.tokenFinalPath
        || !samePath(taskResult.root, taskResult.rootFinalPath)
        || !samePath(taskResult.configFinalPath, resolvedPaths.bridgeConfig)
        || !samePath(taskResult.tokenFinalPath, resolvedPaths.token)) {
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
      const ambiguous = await taskSnapshot(taskName);
      if (ambiguous.exists) {
        if (!verifiedSnapshot(ambiguous, node, expectedArguments, dirname(cli), sid)) {
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
      await stopAndDeleteVerifiedTask(taskName, node, expectedArguments, dirname(cli), sid);
      created = false;
    } catch (cleanupError) {
      pendingError = cleanupError;
      preserveInvocation = true;
    }
  }
  if (lifecycleRunOutcomeIsUncertain(runRequested, resultValidated)
    && pendingError
    && !(pendingError instanceof LifecycleError && pendingError.code === "lifecycle_outcome_uncertain")) {
    pendingError = new LifecycleError("lifecycle_outcome_uncertain", "temporary lifecycle task ended without a validated result; it will not be replayed");
  }
  if (!preserveInvocation) await removeInvocationDirectory(invocation, bridgeRoot, nonce);
  if (pendingError) throw pendingError;
  if (!taskResult) throw new LifecycleError("lifecycle_task_result_invalid", "temporary lifecycle task returned no result");
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return taskResult.exitCode;
}
