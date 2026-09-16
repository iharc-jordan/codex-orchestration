import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { BridgeError, ManagedClient, type ManagedState } from "./client.js";
import { validateConfig, type ConfigDiagnostic } from "./config.js";
import { orchestrationPaths, type OrchestrationPaths } from "./paths.js";

const execFile = promisify(execFileCallback);
const DEFAULT_PORT = 8787;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_NAME = "CodexOrchestration";
const READY_TIMEOUT_MS = 60_000;
const CONTROLLER_ENV_NAME = /^(?:GITHUB_TOKEN|GH_TOKEN|GITHUB_APP_ID|GITHUB_APP_INSTALLATION_ID|GITHUB_APP_PRIVATE_KEY|GITHUB_API_URL|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|API_KEY|API_TOKEN|CLIENT_ID|CLIENT_SECRET|PRIVATE_KEY))$/i;
const CONTROLLER_IDENTITY_NAME = /(?:^|_)(?:thread|task|assignment|conversation|pm|owner|identity|symphony)(?:_|$)/i;

export interface LifecycleOptions {
  executable?: string;
  releaseManifest?: string;
  sha256?: string;
  workflow?: string;
  version?: string;
  port?: number;
  tokenFile?: string;
  launcher?: string;
  /** Internal absolute deadline supplied by the transient lifecycle task. */
  deadlineAt?: number;
}
export type LifecyclePaths = OrchestrationPaths & { taskName: string; workflow: string; };
export class LifecycleError extends Error { constructor(readonly code: string, message: string, readonly status?: number) { super(message); this.name = "LifecycleError"; } }

function paths(options: LifecycleOptions = {}): LifecyclePaths {
  const base = orchestrationPaths();
  return { ...base, taskName: TASK_NAME, workflow: join(base.config, "WORKFLOW.md") };
}
async function run(command: string, args: string[], allowFailure = false): Promise<{ stdout: string; stderr: string; code: number }> {
  try { const value = await execFile(command, args, { windowsHide: true, maxBuffer: 1_048_576 }); return { stdout: value.stdout, stderr: value.stderr, code: 0 }; }
  catch (cause) {
    const value = cause as { stdout?: string; stderr?: string; code?: number };
    if (allowFailure) return { stdout: value.stdout || "", stderr: value.stderr || "", code: typeof value.code === "number" ? value.code : 1 };
    const output = String(value.stderr || value.stdout || "").trim().slice(0, 500);
    throw new LifecycleError("command_failed", command + " " + args.join(" ") + " failed" + (output ? ": " + output : ""), value.code);
  }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (process.platform !== "win32") return;
  const sid = await currentSid();
  const aclOk = (result: { code: number; stdout: string; stderr: string }): boolean => result.code === 0 && !/Failed processing\s+[1-9]/i.test(result.stdout + result.stderr);
  // Recover owner-correct children whose DACL was emptied by an interrupted
  // removal before replacing the root DACL or asking icacls to reset them.
  const rootBootstrap = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":(OI)(CI)F"], true);
  if (!aclOk(rootBootstrap)) throw new LifecycleError("acl_failed", "could not bootstrap private orchestration root ACLs");
  const treeBootstrap = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":F", "/t", "/c"], true);
  if (!aclOk(treeBootstrap)) throw new LifecycleError("acl_failed", "could not bootstrap private orchestration tree ACLs");
  // Set the root DACL directly because resetting it against a protected parent
  // can remove the caller's only ACE. Child resets then inherit this one
  // known-good ACE.
  const rootAclScript = [
    "$sid = New-Object Security.Principal.SecurityIdentifier(" + psQuote(sid) + ")",
    "$acl = New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$flags = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit",
    "$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $flags, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$acl.AddAccessRule($rule)",
    "[IO.Directory]::SetAccessControl(" + psQuote(path) + ", $acl)"
  ].join("; ");
  const rootAcl = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", rootAclScript], true);
  if (rootAcl.code !== 0) throw new LifecycleError("acl_failed", "could not protect the private orchestration root ACL");
  // Reset only descendants. Resetting the root would derive its DACL from its
  // deliberately protected parent and can remove the caller's only ACE.
  const reset = await run("icacls.exe", [join(path, "*"), "/reset", "/t", "/c"], true);
  if (!aclOk(reset)) throw new LifecycleError("acl_failed", "could not reset orchestration state ACLs");
  // Reset can replace explicit child ACEs, so restore one before removing
  // inheritance throughout the tree.
  const acl = await run("icacls.exe", [path, "/grant:r", "*" + sid + ":F", "/t", "/c"], true);
  if (!aclOk(acl)) throw new LifecycleError("acl_failed", "could not protect private orchestration state with the current user ACL");
  const inheritance = await run("icacls.exe", [path, "/inheritance:r", "/t", "/c"], true);
  if (!aclOk(inheritance)) throw new LifecycleError("acl_failed", "could not remove inherited orchestration state ACLs");
  const owner = await run("icacls.exe", [path, "/setowner", "*" + sid, "/t", "/c"], true);
  if (!aclOk(owner)) throw new LifecycleError("acl_failed", "could not set the private orchestration state owner");
}
async function atomic(path: string, body: string | Buffer): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = path + ".tmp-" + process.pid + "-" + randomBytes(4).toString("hex");
  await writeFile(temporary, body, { mode: 0o600 }); await rename(temporary, path);
}
async function optional(path: string): Promise<string | undefined> {
  try { return (await readFile(path, "utf8")).trim() || undefined; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new LifecycleError("read_failed", "could not read " + path); }
}
function releaseVersion(input: string | undefined): string {
  const value = input?.trim() || "local-" + Date.now();
  if (!RELEASE_PATTERN.test(value)) throw new LifecycleError("version_invalid", "version must contain only letters, numbers, dots, underscores, and hyphens");
  return value;
}
export interface RuntimeReleaseManifest { repository: "iharc-jordan/symphony"; version: "0.4.0"; runtimeDownloadUrl: string; sha256: string; distribution: "none"; cookieFile: "absent"; }
export function validateReleaseManifest(value: unknown): RuntimeReleaseManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("release_manifest_invalid", "release manifest must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.repository !== "iharc-jordan/symphony" || raw.version !== "0.4.0") throw new LifecycleError("release_manifest_invalid", "release manifest must identify iharc-jordan/symphony version 0.4.0");
  if (typeof raw.runtimeDownloadUrl !== "string" || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(raw.sha256)) throw new LifecycleError("release_manifest_invalid", "release manifest requires runtimeDownloadUrl and a SHA-256 digest");
  if (raw.distribution !== "none" || raw.cookieFile !== "absent") throw new LifecycleError("release_manifest_invalid", "release manifest must disable Erlang distribution and omit the cookie file");
  let url: URL;
  try { url = new URL(raw.runtimeDownloadUrl); } catch { throw new LifecycleError("release_manifest_invalid", "runtimeDownloadUrl must be an HTTPS GitHub release URL"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/iharc-jordan/symphony/releases/download/v0.4.0/")) throw new LifecycleError("release_manifest_invalid", "runtimeDownloadUrl must pin the Symphony v0.4.0 GitHub release");
  return { repository: "iharc-jordan/symphony", version: "0.4.0", runtimeDownloadUrl: url.toString(), sha256: raw.sha256.toLowerCase(), distribution: "none", cookieFile: "absent" };
}
function absolute(input: string, label: string): string {
  if (!isAbsolute(input)) throw new LifecycleError(label + "_invalid", label + " must be an absolute Windows path");
  return resolve(input);
}
async function regularFile(input: string, label: string): Promise<string> {
  const path = absolute(input, label);
  try { const detail = await stat(path); if (!detail.isFile()) throw new Error("not-file"); const handle = await open(path, constants.R_OK); await handle.close(); }
  catch { throw new LifecycleError(label + "_invalid", label + " is not a readable regular file: " + path); }
  return path;
}

/** The default is public npm's stable Windows shim. No desktop data is scanned. */
export async function resolveCodexLauncher(override?: string): Promise<string> {
  const appData = process.env.APPDATA?.trim();
  const candidate = override?.trim() || (appData ? join(appData, "npm", "codex.cmd") : "");
  if (!candidate) throw new LifecycleError("launcher_missing", "codex.cmd was not found at the public npm path; pass --launcher with an absolute path");
  return regularFile(candidate, "launcher");
}
function cmdCommand(executable: string, fixedArgs: string[]): string {
  const value = absolute(executable, "launcher");
  if (/[\r\n\0]/.test(value)) throw new LifecycleError("command_invalid", "launcher arguments cannot contain control characters");
  if (value.includes("\"")) throw new LifecycleError("command_invalid", "launcher path cannot contain a quote");
  return "\"\"" + value + "\"" + (fixedArgs.length ? " " + fixedArgs.join(" ") : "") + "\"";
}
export function workerCommand(launcher: string): { command: "cmd.exe"; args: string[] } {
  return {
    command: "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      cmdCommand(launcher, ["app-server", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"])
    ]
  };
}
/** Environment boundary for the App Server/helper worker, not the controller. */
export function scrubControllerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP", "CODEX_HOME", "CODEX_CONFIG_DIR", "NODE_OPTIONS"]);
  const secretOrIdentity = /(?:^|_)(?:token|secret|credential|password|authorization|cookie|thread|task|assignment|conversation|pm|owner|identity|symphony)(?:_|$)/i;
  return Object.fromEntries(Object.entries(input).filter(([name, value]) => value !== undefined && (keep.has(name.toUpperCase()) || !secretOrIdentity.test(name)))) as NodeJS.ProcessEnv;
}
function launcherContent(p: LifecyclePaths, port: number): string {
  return [
    "@echo off", "setlocal DisableDelayedExpansion",
    "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + p.runner + "\"",
    "exit /b %ERRORLEVEL%", ""
  ].join("\r\n");
}
function psQuote(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }
export function runnerContent(p: LifecyclePaths, _port: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$controllerEnv = [pscustomobject]@{}",
    "if (Test-Path -LiteralPath " + psQuote(p.controllerEnvironment) + " -PathType Leaf) { $controllerEnv = Get-Content -Raw -LiteralPath " + psQuote(p.controllerEnvironment) + " | ConvertFrom-Json }",
    "$blocked = '(?i)(^|_)(thread|task|assignment|conversation|pm|owner|identity|symphony)(_|$)'",
    "Get-ChildItem Env: | ForEach-Object { if ($_.Name -match $blocked -and -not ($controllerEnv.psobject.Properties.Name -contains $_.Name)) { Remove-Item -LiteralPath ('Env:' + $_.Name) } }",
    "$controllerEnv.psobject.Properties | ForEach-Object { if ($_.Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$' -or $_.Name -match $blocked -or $null -eq $_.Value) { throw 'invalid controller environment' }; Set-Item -LiteralPath ('Env:' + $_.Name) -Value ([string]$_.Value) }",
    "$bridge = Get-Content -Raw -LiteralPath " + psQuote(p.bridgeConfig) + " | ConvertFrom-Json",
    "$port = [int]$bridge.port",
    "if ([string]$bridge.host -ne '127.0.0.1' -or $port -lt 1 -or $port -gt 65535) { exit 78 }",
    "$bridgeTokenRaw = [string]$bridge.token_file",
    "$bridgeToken = if ([IO.Path]::IsPathRooted($bridgeTokenRaw)) { [IO.Path]::GetFullPath($bridgeTokenRaw) } else { [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent " + psQuote(p.bridgeConfig) + ") $bridgeTokenRaw)) }",
    "if ($bridgeToken -ne [IO.Path]::GetFullPath(" + psQuote(p.token) + ")) { exit 78 }",
    "$release = (Get-Content -Raw -LiteralPath " + psQuote(p.current) + ").Trim()",
    "if ($release -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { exit 78 }",
    "$releaseRoot = Join-Path " + psQuote(p.releases) + " $release",
    "$entry = Join-Path $releaseRoot 'bin\\symphony.bat'",
    "if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { exit 78 }",
    "$env:SYMPHONY_WINDOWS_WORKER_HOST = Join-Path (Split-Path -Parent $entry) 'symphony-worker-host.exe'",
    "if (-not (Test-Path -LiteralPath $env:SYMPHONY_WINDOWS_WORKER_HOST -PathType Leaf)) { exit 78 }",
    "$env:SYMPHONY_WORKFLOW_PATH = " + psQuote(p.workflow),
    "$env:SYMPHONY_LOGS_ROOT = " + psQuote(p.logs),
    "$env:SYMPHONY_STATE_ROOT = " + psQuote(p.state),
    "$env:SYMPHONY_WORKSPACES_ROOT = " + psQuote(p.workspaces),
    "$env:SYMPHONY_CONTROL_TOKEN_FILE = $bridgeToken",
    "$env:SYMPHONY_SERVER_HOST = '127.0.0.1'",
    "$env:SYMPHONY_SERVER_PORT = [string]$port",
    "$env:SYMPHONY_MANAGED = 'true'",
    "$env:RELEASE_DISTRIBUTION = 'none'",
    "$env:RELEASE_COOKIE = 'codex_orchestration_local_only'",
    "$controllerIdentity = Join-Path " + psQuote(p.state) + " 'controller-process.json'",
    "$controllerCommand = '\"\"' + $entry + '\" start\"'",
    "$controllerArgs = @('--parent-pid', [string]$PID, '--job-name', 'CodexOrchestrationController', '--identity-file', $controllerIdentity, '--cwd', $releaseRoot, '--attempt-id', 'controller', '--', $env:ComSpec, '/d', '/s', '/c', $controllerCommand)",
    "& $env:SYMPHONY_WINDOWS_WORKER_HOST @controllerArgs",
    "exit $LASTEXITCODE", ""
  ].join("\r\n");
}
function escapeXml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;"); }
export function scheduledTaskXml(p: LifecyclePaths, userSid: string): string {
  const args = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + p.runner + "\"";
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
    "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    "  <RegistrationInfo><Description>Codex Orchestration native Windows service</Description></RegistrationInfo>",
    "  <Triggers><LogonTrigger><UserId>" + escapeXml(userSid) + "</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>",
    "  <Principals><Principal id=\"Author\"><UserId>" + escapeXml(userSid) + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
    "  <Settings><Hidden>true</Hidden><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>",
    "  <Actions Context=\"Author\"><Exec><Command>powershell.exe</Command><Arguments>" + escapeXml(args) + "</Arguments></Exec></Actions>",
    "</Task>", ""
  ].join("\r\n");
}
async function currentSid(): Promise<string> {
  const identity = await run("whoami.exe", ["/user"]);
  const sid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  return sid;
}
async function taskSnapshot(p: LifecyclePaths): Promise<{ exists: boolean; running: boolean; active: boolean }> {
  const script = "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq " + psQuote(p.taskName) + " -and $_.TaskPath -eq '\\' }); if ($tasks.Count -eq 0) { [Console]::WriteLine('{\"exists\":false,\"running\":false,\"active\":false}'); exit 0 }; $state = [int]$tasks[0].State; [Console]::WriteLine((ConvertTo-Json -Compress -InputObject @{ exists = $true; running = ($state -eq 4); active = ($state -eq 2 -or $state -eq 4) }))";
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], true);
  if (result.code !== 0) throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task");
  try {
    const value = JSON.parse(result.stdout.trim()) as { exists?: unknown; running?: unknown; active?: unknown };
    if (typeof value.exists !== "boolean" || typeof value.running !== "boolean" || typeof value.active !== "boolean") throw new Error("invalid");
    return { exists: value.exists, running: value.running, active: value.active };
  } catch { throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task"); }
}
async function taskExists(p: LifecyclePaths): Promise<boolean> { return (await taskSnapshot(p)).exists; }
type NativeTaskDiagnostic = {
  exists: boolean;
  state?: number;
  running: boolean;
  active: boolean;
  lastTaskResult?: number | null;
  lastRunTime?: string | null;
  nextRunTime?: string | null;
  action?: { command: string; arguments: string; hidden: boolean };
};
async function taskDiagnostics(p: LifecyclePaths): Promise<NativeTaskDiagnostic> {
  const taskName = psQuote(p.taskName);
  const script = [
    "$tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq " + taskName + " -and $_.TaskPath -eq '\\' })",
    "if ($tasks.Count -eq 0) { [Console]::WriteLine('{\"exists\":false,\"running\":false,\"active\":false}'); exit 0 }",
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
    const value = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    if (typeof value.exists !== "boolean" || typeof value.running !== "boolean" || typeof value.active !== "boolean") throw new Error("invalid");
    if (!value.exists) return { exists: false, running: false, active: false };
    if (typeof value.state !== "number") throw new Error("invalid state");
    const action = value.action as Record<string, unknown> | undefined;
    return {
      exists: true,
      state: value.state,
      running: value.running,
      active: value.active,
      lastTaskResult: typeof value.lastTaskResult === "number" ? value.lastTaskResult : null,
      lastRunTime: typeof value.lastRunTime === "string" ? value.lastRunTime : null,
      nextRunTime: typeof value.nextRunTime === "string" ? value.nextRunTime : null,
      action: action && typeof action.command === "string" && typeof action.arguments === "string" && typeof action.hidden === "boolean"
        ? { command: action.command, arguments: action.arguments, hidden: action.hidden }
        : undefined
    };
  } catch { throw new LifecycleError("task_inspection_failed", "could not inspect the orchestration scheduled task"); }
}
async function releaseEntryDiagnostics(p: LifecyclePaths, label: string | undefined): Promise<Record<string, unknown>> {
  if (!label || !RELEASE_PATTERN.test(label)) return { label: label || null, valid: false, error: "selected release pointer is missing or invalid" };
  const releaseRoot = join(p.releases, label);
  const entry = join(releaseRoot, "bin", "symphony.bat");
  const workerHost = join(releaseRoot, "bin", "symphony-worker-host.exe");
  const environment = join(releaseRoot, "releases", label, "env.bat");
  const cookie = join(releaseRoot, "releases", "COOKIE");
  const isRegular = async (file: string): Promise<boolean> => { try { return (await lstat(file)).isFile(); } catch { return false; } };
  const isAbsent = async (file: string): Promise<boolean> => { try { await lstat(file); return false; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "ENOENT"; } };
  const entryValid = await isRegular(entry);
  const workerHostValid = await isRegular(workerHost);
  let distributionDisabled = false;
  try { distributionDisabled = /^(?:set )?\"?RELEASE_DISTRIBUTION=none\"?\s*$/im.test(await readFile(environment, "utf8")); } catch { distributionDisabled = false; }
  const cookieAbsent = await isAbsent(cookie);
  const valid = entryValid && workerHostValid && distributionDisabled && cookieAbsent;
  return { label, entry, workerHost, environment, entryValid, workerHostValid, distributionDisabled, cookieAbsent, valid, error: valid ? undefined : "selected release must contain regular launch entries, disable Erlang distribution, and omit releases\\COOKIE" };
}
async function taskOwned(p: LifecyclePaths): Promise<boolean> {
  if (!(await taskExists(p))) return true;
  const metadata = await optional(p.metadata);
  if (!metadata) return false;
  try {
    const parsed = JSON.parse(metadata) as { taskName?: unknown; root?: unknown };
    if (parsed.taskName !== p.taskName || parsed.root !== p.root) return false;
  } catch { return false; }
  const task = p.taskName.replaceAll("'", "''");
  const exported = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Export-ScheduledTask -TaskName '" + task + "' | Out-String"], true);
  return exported.code === 0 && exported.stdout.includes("Codex Orchestration native Windows service") && exported.stdout.replaceAll("&quot;", "").includes(p.runner);
}
async function installTask(p: LifecyclePaths, port: number): Promise<void> {
  if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
  await atomic(p.launcher, launcherContent(p, port));
  await atomic(p.runner, runnerContent(p, port));
  await atomic(p.taskXml, Buffer.from("\uFEFF" + scheduledTaskXml(p, await currentSid()), "utf16le"));
  await run("schtasks.exe", ["/Create", "/TN", p.taskName, "/XML", p.taskXml, "/F"]);
}
async function taskRunning(p: LifecyclePaths): Promise<boolean> {
  return (await taskSnapshot(p)).running;
}
async function stopRecordedController(p: LifecyclePaths): Promise<void> {
  const identityPath = join(p.state, "controller-process.json");
  const identityRaw = await optional(identityPath);
  if (!identityRaw) return;
  const release = await optional(p.current);
  if (!release || !RELEASE_PATTERN.test(release)) throw new LifecycleError("controller_identity_invalid", "controller identity exists without a valid selected release");
  const helper = await regularFile(join(p.releases, release, "bin", "symphony-worker-host.exe"), "worker_host");
  let identity: Record<string, unknown>;
  try { identity = JSON.parse(identityRaw) as Record<string, unknown>; }
  catch { throw new LifecycleError("controller_identity_invalid", "controller process identity is not valid JSON"); }
  const creationMatches = Array.from(identityRaw.matchAll(/"child_creation_time"\s*:\s*(\d+)/g));
  const pid = identity.child_pid;
  if (identity.version !== 1 || identity.job_name !== "CodexOrchestrationController" || identity.attempt_id !== "controller" || !Number.isInteger(pid) || Number(pid) < 1 || Number(pid) > 0xffff_ffff || creationMatches.length !== 1) {
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
async function stopTask(p: LifecyclePaths): Promise<void> {
  const before = await taskSnapshot(p);
  await stopRecordedController(p);
  if (!before.exists) return;
  const afterControllerStop = await taskSnapshot(p);
  if (afterControllerStop.active) {
    const ended = await run("schtasks.exe", ["/End", "/TN", p.taskName], true);
    if (ended.code !== 0) throw new LifecycleError("task_stop_failed", "could not stop the orchestration scheduled task");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await taskSnapshot(p)).active) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new LifecycleError("task_stop_failed", "orchestration scheduled task did not stop before the release switch");
}
/** Stop only a task that this private installation can prove it owns. */
export async function stopOwnedTask(p: LifecyclePaths): Promise<void> {
  if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
  await stopTask(p);
}
async function readReleaseManifest(path: string): Promise<RuntimeReleaseManifest> {
  try { return validateReleaseManifest(JSON.parse(await readFile(await regularFile(path, "release_manifest"), "utf8"))); }
  catch (cause) { if (cause instanceof LifecycleError) throw cause; throw new LifecycleError("release_manifest_invalid", "release manifest is not valid JSON"); }
}
function sha256(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new LifecycleError("sha256_invalid", "a 64-character SHA-256 digest is required for a release ZIP");
  return value.toLowerCase();
}
async function verifiedReleaseSource(p: LifecyclePaths, options: LifecycleOptions): Promise<{ path: string; downloaded: boolean }> {
  const manifest = options.releaseManifest ? await readReleaseManifest(options.releaseManifest) : undefined;
  const requestedSha = options.sha256 ? sha256(options.sha256) : undefined;
  if (manifest && requestedSha && requestedSha !== manifest.sha256) throw new LifecycleError("release_hash_mismatch", "offline SHA-256 does not match the pinned release manifest");
  const expected = manifest?.sha256 || requestedSha;
  if (!expected) throw new LifecycleError("sha256_invalid", "a 64-character SHA-256 digest is required for a release ZIP");
  let source: string;
  let downloaded = false;
  if (options.executable) source = await regularFile(options.executable, "release");
  else {
    if (!manifest) throw new LifecycleError("release_source_required", "provide --release-manifest or an offline --executable ZIP with --sha256");
    source = join(p.state, "download-" + randomBytes(8).toString("hex") + ".zip"); downloaded = true;
    let response: Response;
    try { response = await fetch(manifest.runtimeDownloadUrl, { redirect: "follow", signal: AbortSignal.timeout(remainingDeadline(options.deadlineAt, 60_000)) }); }
    catch { throw new LifecycleError("release_download_failed", "could not download the pinned Symphony release ZIP"); }
    let finalUrl: URL;
    try { finalUrl = new URL(response.url || manifest.runtimeDownloadUrl); } catch { throw new LifecycleError("release_download_failed", "pinned Symphony release URL was invalid"); }
    const githubReleaseHosts = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
    if (finalUrl.protocol !== "https:" || !githubReleaseHosts.has(finalUrl.hostname.toLowerCase())) throw new LifecycleError("release_download_failed", "pinned Symphony release redirected outside GitHub");
    if (finalUrl.hostname.toLowerCase() === "github.com" && !finalUrl.pathname.startsWith("/iharc-jordan/symphony/releases/download/v0.4.0/")) throw new LifecycleError("release_download_failed", "pinned Symphony release redirected to an unapproved GitHub path");
    if (!response.ok) throw new LifecycleError("release_download_failed", "could not download the pinned Symphony release ZIP");
    await writeFile(source, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  if (extname(source).toLowerCase() !== ".zip") throw new LifecycleError("release_invalid", "release must be a standard Windows Mix release ZIP");
  const actual = createHash("sha256").update(await readFile(source)).digest("hex");
  if (actual !== expected) { if (downloaded) await rm(source, { force: true }); throw new LifecycleError("release_hash_mismatch", "release ZIP SHA-256 does not match the pinned expected digest"); }
  return { path: source, downloaded };
}
async function stageRelease(p: LifecyclePaths, options: LifecycleOptions, release: string): Promise<void> {
  const input = await verifiedReleaseSource(p, options); const source = input.path; const root = join(p.releases, release); const target = join(root, "bin", "symphony.bat"); const workerHost = join(root, "bin", "symphony-worker-host.exe"); const environment = join(root, "releases", release, "env.bat"); const cookie = join(root, "releases", "COOKIE");
  if (extname(source).toLowerCase() !== ".zip") throw new LifecycleError("release_invalid", "release must be a standard Windows Mix release ZIP");
  try { await stat(root); if (input.downloaded) await rm(source, { force: true }); throw new LifecycleError("release_exists", "release " + release + " already exists and is immutable"); }
  catch (cause) { if (cause instanceof LifecycleError) throw cause; if ((cause as NodeJS.ErrnoException).code !== "ENOENT") { if (input.downloaded) await rm(source, { force: true }); throw new LifecycleError("release_invalid", "could not inspect release " + release); } }
  await privateDirectory(root);
  try {
    await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath " + psQuote(source) + " -DestinationPath " + psQuote(root) + " -ErrorAction Stop"]);
    const targetInfo = await lstat(target); const workerInfo = await lstat(workerHost); const environmentInfo = await lstat(environment);
    if (!targetInfo.isFile() || !workerInfo.isFile() || !environmentInfo.isFile()) throw new Error("release entries must be files");
    const environmentContents = await readFile(environment, "utf8");
    if (!/^(?:set )?\"?RELEASE_DISTRIBUTION=none\"?\s*$/im.test(environmentContents)) throw new Error("release distribution must be disabled");
    try { await lstat(cookie); throw new Error("release cookie must be absent"); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  }
  catch { await rm(root, { recursive: true, force: true }); throw new LifecycleError("release_invalid", "release ZIP must contain bin\\symphony.bat and bin\\symphony-worker-host.exe"); }
  finally { if (input.downloaded) await rm(source, { force: true }); }
  const old = await optional(p.current); if (old) await atomic(p.previous, old + "\n"); await atomic(p.current, release + "\n");
}
export function configuredWorkflow(content: string, launcher: string): string {
  const resolvedLauncher = JSON.stringify(absolute(launcher, "launcher"));
  const pieces = content.split(/(\r\n|\n|\r)/); const lines: Array<{ text: string; eol: string }> = [];
  for (let index = 0; index < pieces.length; index += 2) lines.push({ text: pieces[index], eol: pieces[index + 1] || "" });
  const first = (lines[0]?.text || "").replace(/^\uFEFF/, "").trim();
  const frontmatterEnd = first === "---" ? lines.findIndex((line, index) => index > 0 && (line.text.trim() === "---" || line.text.trim() === "...")) : lines.length;
  const limit = frontmatterEnd >= 0 ? frontmatterEnd : lines.length;
  const codexIndex = lines.findIndex((line, index) => index < limit && /^codex\s*:/.test(line.text));
  if (codexIndex < 0) throw new LifecycleError("workflow_invalid", "workflow must include a codex section");
  const eol = lines[codexIndex].eol || lines.find((line) => line.eol)?.eol || "\r\n";
  const codexMatch = lines[codexIndex].text.match(/^(\s*)codex\s*:\s*(.*)$/)!; const codexIndent = codexMatch[1].length; const inline = codexMatch[2].trim();
  if (inline.startsWith("{") && inline.endsWith("}")) {
    const fields = inlineFields(inline.slice(1, -1)).filter((field) => !/^\s*(?:command|args|launcher)\s*:/.test(field));
    lines[codexIndex].text = codexMatch[1] + "codex: { launcher: " + resolvedLauncher + (fields.length ? ", " + fields.join(", ") : "") + " }";
    return lines.map((line) => line.text + line.eol).join("");
  }
  let childIndent = codexIndent + 2; let sectionEnd = limit;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text; if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) { sectionEnd = index; break; }
    childIndent = indent; break;
  }
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text; if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) { sectionEnd = index; break; }
  }
  const kept: Array<{ text: string; eol: string }> = [{ text: codexMatch[1] + "codex:", eol } , { text: " ".repeat(childIndent) + "launcher: " + resolvedLauncher, eol }];
  let skipIndent: number | undefined;
  for (let index = codexIndex + 1; index < sectionEnd; index += 1) {
    const line = lines[index]; const text = line.text; const trimmed = text.trim(); const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (skipIndent !== undefined) {
      if (!trimmed || indent > skipIndent) continue;
      skipIndent = undefined;
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
function workflowStatus(content: string): { hasLauncher: boolean; hasLegacy: boolean } {
  const pieces = content.split(/(\r\n|\n|\r)/); const lines: Array<{ text: string; eol: string }> = [];
  for (let index = 0; index < pieces.length; index += 2) lines.push({ text: pieces[index], eol: pieces[index + 1] || "" });
  const first = (lines[0]?.text || "").replace(/^\uFEFF/, "").trim();
  const frontmatterEnd = first === "---" ? lines.findIndex((line, index) => index > 0 && (line.text.trim() === "---" || line.text.trim() === "...")) : lines.length;
  const limit = frontmatterEnd >= 0 ? frontmatterEnd : lines.length;
  const codexIndex = lines.findIndex((line, index) => index < limit && /^codex\s*:/.test(line.text));
  if (codexIndex < 0) return { hasLauncher: false, hasLegacy: false };
  const header = lines[codexIndex].text.match(/^(\s*)codex\s*:\s*(.*)$/)!;
  const codexIndent = header[1].length; const inline = header[2].trim();
  if (inline.startsWith("{") && inline.endsWith("}")) {
    const fields = inlineFields(inline.slice(1, -1));
    return { hasLauncher: fields.some((field) => /^launcher\s*:/i.test(field)), hasLegacy: fields.some((field) => /^(?:command|args)\s*:/i.test(field)) };
  }
  let childIndent: number | undefined;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text; if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) break;
    childIndent = indent; break;
  }
  if (childIndent === undefined) return { hasLauncher: false, hasLegacy: false };
  let hasLauncher = false; let hasLegacy = false;
  for (let index = codexIndex + 1; index < limit; index += 1) {
    const text = lines[index].text; if (!text.trim() || /^\s*#/.test(text)) continue;
    const indent = text.match(/^[ \t]*/)?.[0].length || 0;
    if (indent <= codexIndent) break;
    if (indent !== childIndent) continue;
    const key = text.match(/^\s*(command|launcher|args)\s*:/i)?.[1]?.toLowerCase();
    if (key === "launcher") hasLauncher = true;
    if (key === "command" || key === "args") hasLegacy = true;
  }
  return { hasLauncher, hasLegacy };
}
function inlineFields(value: string): string[] {
  const fields: string[] = []; let start = 0; let quote = ""; let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) { if (char === quote && value[index - 1] !== "\\") quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) { fields.push(value.slice(start, index).trim()); start = index + 1; }
  }
  const final = value.slice(start).trim(); if (final) fields.push(final); return fields;
}
async function stageWorkflow(p: LifecyclePaths, source: string | undefined, launcher: string): Promise<void> {
  let content: string;
  if (source) content = await readFile(await regularFile(source, "workflow"), "utf8");
  else {
    const current = await optional(p.workflow);
    if (current === undefined) throw new LifecycleError("workflow_missing", "setup requires --workflow for the first install");
    content = current;
  }
  await atomic(p.workflow, configuredWorkflow(content, launcher));
}
async function writeConfiguration(p: LifecyclePaths, options: LifecycleOptions): Promise<number> {
  let port = options.port;
  let existingConfig: Record<string, unknown> = {};
  if (port === undefined) {
    const current = await optional(p.bridgeConfig);
    if (current) {
      try {
        const parsed = JSON.parse(current) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        existingConfig = parsed as Record<string, unknown>;
        port = Number(existingConfig.port);
      }
      catch { throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON"); }
    }
  } else {
    const current = await optional(p.bridgeConfig);
    if (current) {
      try {
        const parsed = JSON.parse(current) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        existingConfig = parsed as Record<string, unknown>;
      } catch { throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON"); }
    }
  }
  port ??= DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LifecycleError("port_invalid", "port must be an integer from 1 through 65535");
  if (!(await optional(p.token))) {
    const token = options.tokenFile ? (await readFile(await regularFile(options.tokenFile, "token_file"), "utf8")).trim() : randomBytes(32).toString("hex");
    if (!token) throw new LifecycleError("token_invalid", "token file is empty"); await atomic(p.token, token + "\n");
  }
  await atomic(p.bridgeConfig, JSON.stringify({ ...existingConfig, host: "127.0.0.1", port, token_file: p.token, max_input_bytes: 16 * 1024 }, null, 2) + "\n");
  return port;
}
async function writeControllerEnvironment(p: LifecyclePaths): Promise<void> {
  const isAllowed = (name: string): boolean => CONTROLLER_ENV_NAME.test(name) && !CONTROLLER_IDENTITY_NAME.test(name);
  const captured = captureControllerEnvironment(process.env);
  const saved: Record<string, string> = {};
  const existing = await optional(p.controllerEnvironment);
  if (existing) {
    try {
      const value = JSON.parse(existing) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid controller environment");
      for (const [name, entry] of Object.entries(value)) {
        if (isAllowed(name) && typeof entry === "string") saved[name] = entry;
      }
    } catch { throw new LifecycleError("controller_environment_invalid", "private controller environment is not valid JSON"); }
  }
  Object.assign(saved, captured);
  await atomic(p.controllerEnvironment, JSON.stringify(saved, null, 2) + "\n");
}

/** Exact provider-auth subset transferred through the private one-shot request. */
export function captureControllerEnvironment(input: NodeJS.ProcessEnv): Record<string, string> {
  const isAllowed = (name: string): boolean => CONTROLLER_ENV_NAME.test(name) && !CONTROLLER_IDENTITY_NAME.test(name);
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined && isAllowed(entry[0]))
  );
}

function remainingDeadline(deadlineAt: number | undefined, maximum: number): number {
  if (deadlineAt === undefined) return maximum;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new LifecycleError("lifecycle_deadline_exceeded", "the lifecycle command exceeded its absolute deadline");
  return Math.min(maximum, remaining);
}
async function acquireWindowsMutex(): Promise<() => Promise<void>> {
  const script = "$mutex = New-Object System.Threading.Mutex($false, 'Local\\CodexOrchestrationLifecycle'); if (-not $mutex.WaitOne(0)) { exit 173 }; [Console]::Out.WriteLine('acquired'); [Console]::In.ReadLine() | Out-Null; $mutex.ReleaseMutex(); $mutex.Dispose()";
  const holder = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const acquired = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    holder.stdout.once("data", (chunk) => { clearTimeout(timer); resolve(String(chunk).trim() === "acquired"); });
    holder.once("error", () => { clearTimeout(timer); resolve(false); });
    holder.once("close", () => { clearTimeout(timer); resolve(false); });
  });
  if (!acquired) { holder.kill(); throw new LifecycleError("lifecycle_busy", "another Codex Orchestration lifecycle command is already running"); }
  return async () => { holder.stdin.end(); if (holder.exitCode === null) await once(holder, "close"); };
}
async function withMutex<T>(_p: LifecyclePaths, work: () => Promise<T>): Promise<T> {
  const release = await acquireWindowsMutex();
  try { return await work(); } finally { await release(); }
}
async function configuredClient(p: LifecyclePaths): Promise<ManagedClient> {
  return ManagedClient.fromConfig(undefined, p.root);
}
async function configuredValidation(p: LifecyclePaths): Promise<ConfigDiagnostic> {
  return validateConfig(p.root);
}

export function boundedStartupLogCause(contents: string): string | undefined {
  const exitAtom = Array.from(contents.matchAll(/\*\* \(EXIT\) :([a-z][a-z0-9_]{1,80})/g)).at(-1)?.[1];
  if (exitAtom) return exitAtom;
  const missing = Array.from(contents.matchAll(/\b(missing_[a-z][a-z0-9_]{1,80})\b/g)).at(-1)?.[1];
  return missing;
}

export function freshStartupLogCause(contents: string, modifiedAt: number, launchAt: number): string | undefined {
  if (!Number.isFinite(modifiedAt) || modifiedAt < launchAt) return undefined;
  return boundedStartupLogCause(contents);
}

async function latestStartupLogCause(p: LifecyclePaths, launchAt: number): Promise<string | undefined> {
  try {
    const directory = join(p.logs, "log");
    const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^symphony\.log\.\d+$/.test(entry.name));
    const files = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
    const latest = files.sort((left, right) => right.modified - left.modified)[0];
    if (!latest || latest.modified < launchAt) return undefined;
    const details = await stat(latest.path);
    const length = Math.min(details.size, 16 * 1024);
    const handle = await open(latest.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, details.size - length));
      return freshStartupLogCause(buffer.toString("utf8"), details.mtimeMs, launchAt);
    } finally { await handle.close(); }
  } catch { return undefined; }
}

async function terminalStartupFailure(p: LifecyclePaths, launchAt: number): Promise<string | undefined> {
  try {
    const task = await taskDiagnostics(p);
    const lastRun = task.lastRunTime ? Date.parse(task.lastRunTime) : Number.NaN;
    if (task.active || !Number.isFinite(lastRun) || lastRun < launchAt - 2_000) return undefined;
    const cause = await latestStartupLogCause(p, launchAt);
    const result = task.lastTaskResult ?? "unknown";
    return "scheduled task exited during startup with result " + result + (cause ? ": " + cause : "");
  } catch { return undefined; }
}

async function waitUntilReady(p: LifecyclePaths, lifecycleDeadline?: number, launchAt = Date.now()): Promise<void> {
  const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, lifecycleDeadline ?? Number.POSITIVE_INFINITY); let diagnostic = "task launch";
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: NodeJS.Timeout | undefined;
    try {
      const client = await Promise.race([
        configuredClient(p),
        new Promise<ManagedClient>((_, reject) => { timer = setTimeout(() => reject(new LifecycleError("readiness_timeout", "readiness probe exceeded the 60-second deadline")), remaining); })
      ]);
      const probeRemaining = deadline - Date.now();
      if (probeRemaining <= 0) break;
      await client.state({}, probeRemaining); return;
    }
    catch (cause) {
      diagnostic = cause instanceof Error ? cause.message : "loopback probe failed";
      const terminal = await terminalStartupFailure(p, launchAt);
      if (terminal) throw new LifecycleError("startup_task_failed", terminal);
      const pause = Math.min(500, Math.max(0, deadline - Date.now()));
      if (pause > 0) await new Promise((done) => setTimeout(done, pause));
    }
    finally { if (timer) clearTimeout(timer); }
  }
  throw new LifecycleError("readiness_timeout", "Symphony did not become ready within 60 seconds after task launch: " + diagnostic);
}

async function setupUnlocked(p: LifecyclePaths, options: LifecycleOptions): Promise<LifecyclePaths> {
  const existingTask = await taskSnapshot(p);
  if (existingTask.exists && !(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
  if (existingTask.active) await stopOwnedTask(p);
  for (const directory of [p.root, p.releases, p.config, p.state, p.logs, p.workspaces]) await privateDirectory(directory);
  await writeControllerEnvironment(p);
  const port = await writeConfiguration(p, options);
  const existingWorkflow = await optional(p.workflow);
  const workflowState = existingWorkflow === undefined ? { hasLauncher: false, hasLegacy: false } : workflowStatus(existingWorkflow);
  const workflowNeedsConfiguration = Boolean(options.workflow || options.launcher || existingWorkflow === undefined || !workflowState.hasLauncher || workflowState.hasLegacy);
  if (workflowNeedsConfiguration) {
    await stageWorkflow(p, options.workflow, await resolveCodexLauncher(options.launcher));
  }
  if (options.executable || options.releaseManifest) await stageRelease(p, options, releaseVersion(options.version));
  if (!(await optional(p.current))) throw new LifecycleError("release_missing", "provide --executable for the first install");
  await installTask(p, port);
  await atomic(p.metadata, JSON.stringify({ taskName: p.taskName, root: p.root, installedAt: new Date().toISOString() }, null, 2) + "\n");
  return p;
}
export async function setup(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  const p = paths(options); return withMutex(p, () => setupUnlocked(p, options));
}
export async function diagnostics(options: LifecycleOptions = {}): Promise<Record<string, unknown>> {
  const p = paths(options); const config = await configuredValidation(p); const selected = await optional(p.current); const previous = await optional(p.previous);
  let nativeTask: NativeTaskDiagnostic;
  let inspectionError: string | undefined;
  try { nativeTask = await taskDiagnostics(p); } catch (error) {
    nativeTask = { exists: false, running: false, active: false };
    inspectionError = error instanceof LifecycleError ? error.message : "could not inspect the orchestration scheduled task";
  }
  let owned = !nativeTask.exists;
  if (nativeTask.exists) {
    try { owned = await taskOwned(p); } catch { owned = false; }
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
    action: nativeTask.action ?? { command: "powershell.exe", arguments: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + p.runner + "\"", hidden: true },
    issue: inspectionError || !config.valid ? (inspectionError || config.error || "configuration is invalid") : !nativeTask.exists ? "scheduled task is not installed" : !owned ? "scheduled task is not owned by this installation" : !release.valid ? String(release.error) : undefined
  };
  return { valid: config.valid && !inspectionError && nativeTask.exists && owned && release.valid, config, task, startup, paths: p, release: selected, previousRelease: previous };
}
export async function start(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  const p = paths(options); return withMutex(p, async () => {
    const current = await optional(p.current); const task = await taskSnapshot(p);
    if (task.exists && !(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task already exists and is not owned by this installation");
    const needsSetup = Boolean(options.executable || options.releaseManifest || options.workflow || options.port !== undefined || options.tokenFile || options.launcher || !current || !task.exists);
    if (needsSetup) await setupUnlocked(p, options);
    else {
      const config = await configuredValidation(p);
      if (!config.valid) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    }
    const launchAt = Date.now(); await run("schtasks.exe", ["/Run", "/TN", p.taskName]); await waitUntilReady(p, options.deadlineAt, launchAt); return p;
  });
}
async function serviceControl(options: LifecycleOptions, operation: "pause" | "resume", disable: boolean): Promise<unknown> {
  const p = paths(options); let state: ManagedState; const client = await configuredClient(p);
  try { state = await client.state(); } catch (cause) { if (cause instanceof BridgeError) throw new LifecycleError(cause.code, cause.message); throw cause; }
  if (!Number.isInteger(state.revision)) throw new LifecycleError("state_invalid", "managed state did not include a current revision");
  return client.control({ request_id: "cli-" + operation + "-" + Date.now() + "-" + randomBytes(6).toString("hex"), operation, args: { scope: "service", expected_revision: state.revision, disable } });
}
export async function pause(options: LifecycleOptions = {}): Promise<unknown> { const p = paths(options); return withMutex(p, () => serviceControl(options, "pause", false)); }
export async function resume(options: LifecycleOptions = {}): Promise<unknown> { const p = paths(options); return withMutex(p, () => serviceControl(options, "resume", false)); }
export async function stop(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  const p = paths(options); return withMutex(p, async () => {
    if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    let serviceError: unknown;
    let taskError: unknown;
    try { await serviceControl(options, "pause", true); } catch (error) { serviceError = error; }
    try { await stopTask(p); } catch (error) { taskError = error; }
    if (serviceError && taskError) {
      const describe = (error: unknown, fallback: string): string => {
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
export async function upgrade(options: LifecycleOptions): Promise<LifecyclePaths> {
  if (!options.executable && !options.releaseManifest) throw new LifecycleError("release_source_required", "upgrade requires --release-manifest or an offline --executable ZIP with --sha256");
  const p = paths(options); return withMutex(p, async () => {
    if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    const active = await taskRunning(p); await stopOwnedTask(p); await stageRelease(p, options, releaseVersion(options.version));
    const config = await configuredValidation(p); if (!config.valid || !config.port) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    await installTask(p, config.port); if (active) { const launchAt = Date.now(); await run("schtasks.exe", ["/Run", "/TN", p.taskName]); await waitUntilReady(p, options.deadlineAt, launchAt); } return p;
  });
}
export async function rollback(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  const p = paths(options); return withMutex(p, async () => {
    if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation");
    const previous = await optional(p.previous); const current = await optional(p.current);
    if (!previous || !current) throw new LifecycleError("rollback_unavailable", "no previous release is available for rollback");
    const active = await taskRunning(p); await stopOwnedTask(p); await atomic(p.current, previous + "\n"); await atomic(p.previous, current + "\n");
    const config = await configuredValidation(p); if (!config.valid || !config.port) throw new LifecycleError("config_invalid", config.error || "bridge config is invalid");
    await installTask(p, config.port); if (active) { const launchAt = Date.now(); await run("schtasks.exe", ["/Run", "/TN", p.taskName]); await waitUntilReady(p, options.deadlineAt, launchAt); } return p;
  });
}
export async function uninstall(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  const p = paths(options); return withMutex(p, async () => { if (!(await taskOwned(p))) throw new LifecycleError("task_owned_elsewhere", "scheduled task exists and is not owned by this installation"); await stopOwnedTask(p); if (await taskExists(p)) await run("schtasks.exe", ["/Delete", "/TN", p.taskName, "/F"]); await rm(p.launcher, { force: true }); await rm(p.runner, { force: true }); await rm(p.taskXml, { force: true }); await rm(p.metadata, { force: true }); return p; });
}
export async function validateConfigForHost(testRoot?: string): Promise<ConfigDiagnostic> { return validateConfig(testRoot); }
