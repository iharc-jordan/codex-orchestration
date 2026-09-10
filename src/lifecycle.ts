import { access, chmod, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { BridgeError, ManagedClient, type ManagedState } from "./client.js";
import { validateConfig, type ConfigDiagnostic } from "./config.js";
import { toWslPath, toWslServicePath } from "./paths.js";

const execFile = promisify(nodeExecFile);
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.@-]{1,80}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

export interface LifecyclePaths {
  configRoot: string;
  dataRoot: string;
  stateRoot: string;
  releasesRoot: string;
  currentRelease: string;
  previousRelease: string;
  wrapper: string;
  workflow: string;
  token: string;
  bridgeConfig: string;
  logsRoot: string;
  journalRoot: string;
  workspacesRoot: string;
  lock: string;
  unit: string;
  launcher: string;
  helper: string;
  taskXml: string;
  metadata: string;
  enabledMarker: string;
  serviceName: string;
  taskName: string;
}

export interface LifecycleOptions {
  executable?: string;
  workflow?: string;
  version?: string;
  host?: string;
  port?: number;
  tokenFile?: string;
  serviceName?: string;
  root?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class LifecycleError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.status = status;
  }
}

export function lifecyclePaths(env: NodeJS.ProcessEnv = process.env, os = platform()): LifecyclePaths {
  const home = env.USERPROFILE || env.HOME || homedir();
  const root = env.CODEX_ORCHESTRATION_HOME?.trim();
  const configBase = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  const dataBase = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const stateBase = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  const configRoot = root ? join(root, "config") : join(configBase, "codex-orchestration");
  const dataRoot = root ? join(root, "data") : join(dataBase, "codex-orchestration");
  const stateRoot = root ? join(root, "state") : join(stateBase, "codex-orchestration");
  const serviceName = env.CODEX_ORCHESTRATION_SERVICE_NAME?.trim() || "codex-orchestration.service";
  const serviceIdentity = serviceName.replace(/\.service$/, "");
  if (!SERVICE_NAME_PATTERN.test(serviceIdentity) || serviceIdentity === "." || serviceIdentity === "..") {
    throw new LifecycleError("service_name_invalid", "service name contains unsupported characters");
  }
  const taskName = env.CODEX_ORCHESTRATION_TASK_NAME?.trim() || `Codex-Orchestration-${randomBytes(4).toString("hex")}`;
  const unitRoot = root ? join(root, "systemd", "user") : os === "win32" ? join(configRoot, "systemd", "user") : join(configBase, "systemd", "user");
  return {
    configRoot,
    dataRoot,
    stateRoot,
    releasesRoot: join(dataRoot, "releases"),
    currentRelease: join(dataRoot, "current-release"),
    previousRelease: join(dataRoot, "previous-release"),
    wrapper: join(dataRoot, "bin", "run-managed.sh"),
    workflow: join(configRoot, "WORKFLOW.md"),
    token: join(configRoot, "token"),
    bridgeConfig: join(configRoot, "config.json"),
    logsRoot: join(stateRoot, "logs"),
    journalRoot: join(stateRoot, "journal"),
    workspacesRoot: join(stateRoot, "workspaces"),
    lock: join(stateRoot, "managed.lock"),
    unit: join(unitRoot, serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`),
    launcher: join(dataRoot, "bin", "windows-launcher.ps1"),
    helper: join(dataRoot, "bin", "checkout-helper.mjs"),
    taskXml: join(dataRoot, "bin", "windows-task.xml"),
    metadata: join(dataRoot, "installation.json"),
    enabledMarker: join(stateRoot, "service-enabled"),
    serviceName: serviceName.endsWith(".service") ? serviceName : `${serviceName}.service`,
    taskName
  };
}

function hostPath(input: string): string {
  if (platform() !== "win32" || !input.startsWith("/mnt/")) return resolve(input);
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(input);
  if (!match) throw new LifecycleError("path_invalid", "WSL path must use a local mounted Windows drive");
  return win32.resolve(`${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`);
}

function servicePath(input: string): string {
  return platform() === "win32" ? toWslServicePath(input) : input;
}

function applyOptions(options: LifecycleOptions): void {
  if (options.root) process.env.CODEX_ORCHESTRATION_HOME = options.root;
  if (options.serviceName) process.env.CODEX_ORCHESTRATION_SERVICE_NAME = options.serviceName;
}

function quoteShell(input: string): string {
  return `'${input.replaceAll("'", `'"'"'`)}'`;
}

function unitQuote(input: string): string {
  return `"${input.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%")}"`;
}

function commandError(command: string, args: string[], error: unknown): LifecycleError {
  const details = error as { stdout?: string; stderr?: string; code?: string | number };
  const output = `${details.stderr || details.stdout || ""}`.trim();
  return new LifecycleError("command_failed", `${command} ${args.join(" ")} failed${output ? `: ${output.slice(0, 500)}` : ""}`, typeof details.code === "number" ? details.code : undefined);
}

async function run(command: string, args: string[], allowFailure = false, hostCommand = false): Promise<CommandResult> {
  const actualCommand = platform() === "win32" && !hostCommand ? "wsl.exe" : command;
  const actualArgs = platform() === "win32" && !hostCommand ? ["-d", "Ubuntu", "--", command, ...args] : args;
  try {
    const result = await execFile(actualCommand, actualArgs, { windowsHide: true, maxBuffer: 1_048_576 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    if (allowFailure) {
      const details = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: details.stdout || "", stderr: details.stderr || "", code: typeof details.code === "number" ? details.code : 1 };
    }
    throw commandError(command, args, error);
  }
}

async function runHost(command: string, args: string[], allowFailure = false): Promise<CommandResult> {
  return run(command, args, allowFailure, true);
}

function wslOptionPath(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) ? toWslPath(value) : value;
}

function delegatedOptionArgs(options: LifecycleOptions): string[] {
  const args: string[] = [];
  const values: Array<[string, string | undefined, boolean]> = [
    ["--executable", options.executable, true],
    ["--workflow", options.workflow, true],
    ["--version", options.version, false],
    ["--host", options.host, false],
    ["--port", options.port === undefined ? undefined : String(options.port), false],
    ["--token-file", options.tokenFile, true],
    ["--root", options.root, true],
    ["--service-name", options.serviceName, false]
  ];
  for (const [name, value, path] of values) {
    if (value === undefined) continue;
    args.push(name, path ? wslOptionPath(value) : value);
  }
  return args;
}

async function resolveWslNode(): Promise<string> {
  const result = await runHost("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node -p process.execPath"], true);
  if (result.code !== 0) throw new LifecycleError("wsl_node_missing", "could not resolve a Linux Node runtime in Ubuntu WSL");
  const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\/(?!mnt\/)[^\r\n]+\/node$/.test(line)).pop();
  if (!candidate) throw new LifecycleError("wsl_node_missing", "Ubuntu WSL did not return a Linux Node runtime");
  return candidate;
}

async function runWslCli(command: string, options: LifecycleOptions = {}): Promise<unknown> {
  const scriptInput = process.argv[1] || resolve("mcp/cli.mjs");
  const script = scriptInput.startsWith("/") ? scriptInput : wslOptionPath(resolve(scriptInput));
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
  const inherited = new Map<string, string | undefined>([
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
      const output = `${result.stderr}\n${result.stdout}`.trim();
      throw new LifecycleError("delegated_failed", output.slice(0, 500) || `WSL ${command} failed`);
    }
    return value;
  } catch {
    if (result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`.trim();
      throw new LifecycleError("delegated_failed", output.slice(0, 500) || `WSL ${command} failed`);
    }
    throw new LifecycleError("delegated_invalid", `WSL ${command} returned invalid lifecycle JSON`);
  }
}

function windowsKeeperPaths(linuxPaths: LifecyclePaths): LifecyclePaths {
  const home = process.env.USERPROFILE || homedir();
  const configuredData = process.env.XDG_DATA_HOME?.trim();
  const dataBase = configuredData && /^[A-Za-z]:[\\/]/.test(configuredData) ? configuredData : join(home, ".local", "share");
  const service = linuxPaths.serviceName.replace(/\.service$/, "");
  const root = join(dataBase, "codex-orchestration", service);
  return {
    ...linuxPaths,
    launcher: join(root, "bin", "windows-launcher.ps1"),
    taskXml: join(root, "bin", "windows-task.xml"),
    metadata: join(root, "installation.json"),
    taskName: `Codex-Orchestration-${randomBytes(4).toString("hex")}`
  };
}

async function writeLinuxMarker(path: string): Promise<void> {
  await run("mkdir", ["-p", dirname(path)]);
  await run("sh", ["-lc", `umask 077; printf '%s\\n' enabled > ${quoteShell(path)}`]);
}

async function removeLinuxMarker(path: string): Promise<void> {
  await run("rm", ["-f", path], true);
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  if (platform() !== "win32") await chmod(path, 0o700);
}

async function writeAtomic(path: string, content: string | NodeJS.ArrayBufferView, mode = 0o600): Promise<void> {
  await ensureDirectory(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(temp, content, { mode });
  if (platform() !== "win32") await chmod(temp, mode);
  await rename(temp, path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new LifecycleError("read_failed", `could not read ${path}`);
  }
}

function validateVersion(version: string | undefined): string {
  const value = version?.trim() || `local-${Date.now()}`;
  if (!RELEASE_PATTERN.test(value)) throw new LifecycleError("version_invalid", "version must contain only letters, numbers, dots, underscores, and hyphens");
  return value;
}

function bundledHelperSource(): string {
  const entrypoint = process.argv[1];
  if (entrypoint && /(?:^|[\\/])mcp[\\/]cli\.mjs$/i.test(entrypoint)) return hostPath(entrypoint);
  return resolve("mcp/cli.mjs");
}

async function stageCheckoutHelper(paths: LifecyclePaths): Promise<void> {
  const source = bundledHelperSource();
  let details;
  try {
    details = await stat(source);
    await access(source, constants.R_OK);
  } catch {
    throw new LifecycleError("helper_invalid", `bundled checkout helper is not readable: ${source}`);
  }
  if (!details.isFile()) throw new LifecycleError("helper_invalid", `bundled checkout helper is not a regular file: ${source}`);
  const temporary = `${paths.helper}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await copyFile(source, temporary);
    if (platform() !== "win32") await chmod(temporary, 0o700);
    await rename(temporary, paths.helper);
  } catch {
    await rm(temporary, { force: true });
    throw new LifecycleError("helper_stage_failed", `could not stage the checkout helper at ${paths.helper}`);
  }
}

function rewriteCheckoutHelperPath(content: string, helperPath: string): string {
  const linePattern = /^([ \t]*checkout_helper_path:)[ \t]*(?:(?:"(?:\\.|[^"\r\n])*")|(?:'(?:''|[^'\r\n])*')|(?:[^#\r\n]*?))([ \t]*(?:#.*))?(\r?\n|$)/gm;
  let replaced = false;
  const result = content.replace(linePattern, (_match, prefix: string, suffix = "", end: string) => {
    replaced = true;
    return `${prefix} ${JSON.stringify(helperPath)}${suffix}${end}`;
  });
  return replaced ? result : content;
}

async function readWorkflow(paths: LifecyclePaths, options: LifecycleOptions): Promise<string> {
  if (options.workflow) {
    const source = hostPath(options.workflow);
    try {
      await access(source, constants.R_OK);
      return await readFile(source, "utf8");
    } catch {
      throw new LifecycleError("workflow_invalid", `workflow is not readable: ${source}`);
    }
  }
  try {
    const existing = await readFile(paths.workflow, "utf8");
    if (!existing.trim()) throw new LifecycleError("workflow_missing", `provide --workflow or create ${paths.workflow}`);
    return existing;
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LifecycleError("workflow_missing", `provide --workflow or create ${paths.workflow}`);
    throw new LifecycleError("workflow_invalid", `workflow is not readable: ${paths.workflow}`);
  }
}

async function validateExecutable(input: string): Promise<string> {
  const path = hostPath(input);
  let details;
  try {
    details = await stat(path);
    await access(path, constants.R_OK | (platform() === "win32" ? 0 : constants.X_OK));
  } catch {
    throw new LifecycleError("executable_invalid", `executable is not readable: ${path}`);
  }
  if (!details.isFile()) throw new LifecycleError("executable_invalid", `executable is not a regular file: ${path}`);
  return path;
}

function serviceInvocation(paths: LifecyclePaths, port: number): string {
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

function unitContent(paths: LifecyclePaths): string {
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

function windowsLauncher(paths: LifecyclePaths): string {
  const service = paths.serviceName.replace(/\.service$/, "");
  const marker = servicePath(paths.enabledMarker);
  const waitScript = `while [ -f ${quoteShell(marker)} ]; do sleep 5; done`;
  const powershellQuote = (input: string): string => `'${input.replaceAll("'", "''")}'`;
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

function taskXml(paths: LifecyclePaths, userSid: string): string {
  const launcher = paths.launcher.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
  const taskName = paths.taskName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
    "<Task version=\"1.4\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">",
    `  <RegistrationInfo><Description>${taskName} keeps the Ubuntu WSL session available for the enabled managed service.</Description></RegistrationInfo>`,
    `  <Triggers><LogonTrigger><UserId>${userSid}</UserId><Enabled>true</Enabled></LogonTrigger></Triggers>`,
    `  <Principals><Principal id=\"Author\"><UserId>${userSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    "  <Settings><Enabled>false</Enabled><Hidden>true</Hidden><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>",
    `  <Actions Context=\"Author\"><Exec><Command>powershell.exe</Command><Arguments>-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File &quot;${launcher}&quot;</Arguments></Exec></Actions>`,
    "</Task>",
    ""
  ].join("\n");
}

interface InstallationMetadata {
  serviceName?: string;
  taskName?: string;
}

async function readMetadata(paths: LifecyclePaths): Promise<InstallationMetadata> {
  const raw = await readOptional(paths.metadata);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InstallationMetadata;
  } catch {
    throw new LifecycleError("metadata_invalid", "installation metadata is invalid");
  }
}

type Ownership = "missing" | "owned" | "foreign";

async function unitOwnership(paths: LifecyclePaths): Promise<Ownership> {
  let details;
  try {
    details = await lstat(paths.unit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new LifecycleError("unit_inspection_failed", `could not inspect service unit ${paths.unit}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) return "foreign";
  const content = await readFile(paths.unit, "utf8");
  const metadata = await readMetadata(paths);
  const expectedExec = `ExecStart=${unitQuote(servicePath(paths.wrapper))}`;
  return metadata.serviceName === paths.serviceName &&
    content.includes("Description=Codex Orchestration managed Symphony") &&
    content.includes(expectedExec) ? "owned" : "foreign";
}

function normalizedTaskText(value: string): string {
  return value.replaceAll("&quot;", "").replaceAll('"', "").replaceAll("\\", "/").toLowerCase();
}

async function taskOwnership(paths: LifecyclePaths): Promise<Ownership> {
  if (platform() !== "win32") return "missing";
  const query = await runHost("schtasks.exe", ["/Query", "/TN", paths.taskName, "/FO", "LIST"], true);
  if (query.code !== 0) {
    const output = `${query.stdout}\n${query.stderr}`;
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
  return metadata.serviceName === paths.serviceName && metadata.taskName === paths.taskName &&
    content.includes(description) && normalized.includes(normalizedTaskText(paths.launcher)) ? "owned" : "foreign";
}

async function applyStoredTaskName(paths: LifecyclePaths): Promise<void> {
  if (platform() !== "win32") return;
  const metadata = await readMetadata(paths);
  if (metadata.serviceName === paths.serviceName && metadata.taskName) paths.taskName = metadata.taskName;
}

async function writeBridgeConfig(paths: LifecyclePaths, options: LifecycleOptions): Promise<void> {
  const existing = await readOptional(paths.bridgeConfig);
  let value: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch {
      throw new LifecycleError("config_invalid", "existing bridge config is not valid JSON");
    }
  }
  value.host = options.host || value.host || DEFAULT_HOST;
  value.port = options.port || value.port || DEFAULT_PORT;
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new LifecycleError("port_invalid", "port must be an integer from 1 through 65535");
  value.token_file = servicePath(paths.token);
  value.max_input_bytes = value.max_input_bytes || 16 * 1024;
  await writeAtomic(paths.bridgeConfig, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeToken(paths: LifecyclePaths, source?: string): Promise<void> {
  if (await readOptional(paths.token)) return;
  const value = source ? (await readFile(hostPath(source), "utf8")).trim() : randomBytes(32).toString("hex");
  if (!value) throw new LifecycleError("token_invalid", "token file is empty");
  await writeAtomic(paths.token, `${value}\n`);
}

async function installUnit(paths: LifecyclePaths): Promise<void> {
  const ownership = await unitOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("unit_owned_elsewhere", `service unit already exists and is not owned by this installation: ${paths.unit}`);
  await writeAtomic(paths.unit, unitContent(paths));
  if (platform() === "win32" || process.env.CODEX_ORCHESTRATION_HOME) {
    await run("systemctl", ["--user", "link", servicePath(paths.unit)]);
    await run("systemctl", ["--user", "daemon-reload"]);
  } else {
    await run("systemctl", ["--user", "daemon-reload"]);
  }
}

async function installWindowsTask(paths: LifecyclePaths): Promise<void> {
  if (platform() !== "win32") return;
  const ownership = await taskOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  await writeAtomic(paths.launcher, windowsLauncher(paths), 0o700);
  const identity = await runHost("whoami.exe", ["/user"]);
  const userSid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!userSid) throw new LifecycleError("identity_invalid", "could not determine the current Windows user SID");
  await writeAtomic(paths.taskXml, Buffer.from(`\uFEFF${taskXml(paths, userSid)}`, "utf16le"));
  await runHost("schtasks.exe", ["/Create", "/TN", paths.taskName, "/XML", paths.taskXml, "/F"]);
  await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"]);
}

async function removeOwnedUnitLink(paths: LifecyclePaths): Promise<void> {
  if (platform() !== "win32" && !process.env.CODEX_ORCHESTRATION_HOME) return;
  const unit = servicePath(paths.unit);
  const linkName = paths.serviceName;
  const script = [
    "set -eu",
    `link=\"\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${linkName}\"`,
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

async function stageRelease(paths: LifecyclePaths, executable: string, version: string): Promise<void> {
  const source = await validateExecutable(executable);
  const targetRoot = join(paths.releasesRoot, version);
  const target = join(targetRoot, "symphony");
  try {
    await stat(target);
    throw new LifecycleError("release_exists", `release ${version} already exists`);
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new LifecycleError("release_invalid", `could not inspect release ${version}`);
  }
  await ensureDirectory(targetRoot);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await copyFile(source, temporary);
  if (platform() !== "win32") await chmod(temporary, 0o755);
  await rename(temporary, target);
  const old = await readOptional(paths.currentRelease);
  if (old) await writeAtomic(paths.previousRelease, `${old}\n`);
  await writeAtomic(paths.currentRelease, `${servicePath(target)}\n`);
}

async function ensureConfigEnv(paths: LifecyclePaths): Promise<void> {
  process.env.CODEX_ORCHESTRATION_CONFIG = paths.bridgeConfig;
}

async function serviceStatus(paths: LifecyclePaths, action: "is-active" | "is-enabled"): Promise<boolean> {
  const result = await run("systemctl", ["--user", action, paths.serviceName], true);
  return result.code === 0;
}

function requestId(operation: string): string {
  return `cli-${operation}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}

async function managedControl(paths: LifecyclePaths, operation: "pause" | "resume", disable: boolean): Promise<unknown> {
  await ensureConfigEnv(paths);
  const client = await ManagedClient.fromConfig();
  let state: ManagedState | undefined;
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
  return client.control({ request_id: requestId(operation), operation, args: { scope: "service", expected_revision: state.revision, disable } });
}

async function setupWindows(options: LifecycleOptions): Promise<LifecyclePaths> {
  const linuxPaths = await runWslCli("setup", options) as LifecyclePaths;
  const paths = windowsKeeperPaths(linuxPaths);
  await applyStoredTaskName(paths);
  const ownership = await taskOwnership(paths);
  if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  await installWindowsTask(paths);
  await writeAtomic(paths.metadata, `${JSON.stringify({ serviceName: paths.serviceName, taskName: paths.taskName, installedAt: new Date().toISOString() }, null, 2)}\n`);
  return paths;
}

export async function setup(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  applyOptions(options);
  if (platform() === "win32") return setupWindows(options);
  const paths = lifecyclePaths(process.env, platform());
  for (const path of [paths.configRoot, paths.dataRoot, paths.stateRoot, paths.releasesRoot, paths.logsRoot, paths.journalRoot, paths.workspacesRoot, dirname(paths.unit), dirname(paths.wrapper)]) await ensureDirectory(path);
  const workflow = await readWorkflow(paths, options);
  await writeToken(paths, options.tokenFile);
  await writeBridgeConfig(paths, options);
  if (options.executable) await stageRelease(paths, options.executable, validateVersion(options.version));
  if (!(await readOptional(paths.currentRelease))) throw new LifecycleError("release_missing", "provide --executable to install the first managed release");
  await stageCheckoutHelper(paths);
  await writeAtomic(paths.workflow, rewriteCheckoutHelperPath(workflow, paths.helper));
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile(paths.bridgeConfig, "utf8")).port)), 0o700);
  if (platform() === "win32") {
    const metadata = await readMetadata(paths);
    if (metadata.serviceName === paths.serviceName && metadata.taskName) paths.taskName = metadata.taskName;
    const ownership = await taskOwnership(paths);
    if (ownership === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${paths.taskName}`);
  }
  await installUnit(paths);
  if (platform() === "win32") {
    await installWindowsTask(paths);
  }
  await writeAtomic(paths.metadata, `${JSON.stringify({ serviceName: paths.serviceName, taskName: paths.taskName, installedAt: new Date().toISOString() }, null, 2)}\n`);
  return paths;
}

export async function validateConfigForHost(): Promise<ConfigDiagnostic> {
  if (platform() === "win32") return await runWslCli("validate-config") as ConfigDiagnostic;
  return validateConfig();
}

export async function diagnostics(options: LifecycleOptions = {}): Promise<Record<string, unknown>> {
  applyOptions(options);
  if (platform() === "win32") return await runWslCli("diagnostics", options) as Record<string, unknown>;
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  await ensureConfigEnv(paths);
  const config = await import("./config.js").then(({ validateConfig }) => validateConfig());
  return {
    valid: config.valid,
    config,
    service: { name: paths.serviceName, active: await serviceStatus(paths, "is-active"), enabled: await serviceStatus(paths, "is-enabled") },
    paths: { config: paths.bridgeConfig, workflow: paths.workflow, helper: paths.helper, data: paths.dataRoot, state: paths.stateRoot, journal: paths.journalRoot, workspaces: paths.workspacesRoot, lock: paths.lock, unit: paths.unit },
    release: await readOptional(paths.currentRelease),
    previousRelease: await readOptional(paths.previousRelease),
    task: platform() === "win32" ? paths.taskName : undefined
  };
}

export async function start(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  applyOptions(options);
  if (platform() === "win32") {
    const paths = await setupWindows(options);
    await run("systemctl", ["--user", "enable", "--now", paths.serviceName]);
    await writeLinuxMarker(paths.enabledMarker);
    await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/ENABLE"]);
    await runHost("schtasks.exe", ["/Run", "/TN", paths.taskName]);
    await runWslCli("resume", options);
    return paths;
  }
  const paths = await setup(options);
  await run("systemctl", ["--user", "enable", "--now", paths.serviceName]);
  if (platform() === "win32") {
    await writeAtomic(paths.enabledMarker, "enabled\n");
    await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/ENABLE"]);
    await runHost("schtasks.exe", ["/Run", "/TN", paths.taskName]);
  }
  await managedControl(paths, "resume", false);
  return paths;
}

export async function pause(options: LifecycleOptions = {}): Promise<unknown> {
  applyOptions(options);
  if (platform() === "win32") return runWslCli("pause", options);
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  return managedControl(paths, "pause", false);
}

export async function resume(options: LifecycleOptions = {}): Promise<unknown> {
  applyOptions(options);
  if (platform() === "win32") return runWslCli("resume", options);
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  return managedControl(paths, "resume", false);
}

export async function stop(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  applyOptions(options);
  if (platform() === "win32") {
    const probe = windowsKeeperPaths(lifecyclePaths(process.env, platform()));
    await applyStoredTaskName(probe);
    const result = await runWslCli("stop", options) as LifecyclePaths;
    await removeLinuxMarker(result.enabledMarker);
    const paths = windowsKeeperPaths(result);
    paths.taskName = probe.taskName;
    await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"], true);
    return paths;
  }
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  await managedControl(paths, "pause", true);
  if (platform() === "win32") await rm(paths.enabledMarker, { force: true });
  await run("systemctl", ["--user", "disable", "--now", paths.serviceName]);
  if (platform() === "win32") await runHost("schtasks.exe", ["/Change", "/TN", paths.taskName, "/DISABLE"]);
  return paths;
}

export async function upgrade(options: LifecycleOptions): Promise<LifecyclePaths> {
  if (!options.executable) throw new LifecycleError("executable_required", "upgrade requires --executable");
  applyOptions(options);
  if (platform() === "win32") return await runWslCli("upgrade", options) as LifecyclePaths;
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  const version = validateVersion(options.version);
  await stageRelease(paths, options.executable, version);
  await stageCheckoutHelper(paths);
  await writeAtomic(paths.workflow, rewriteCheckoutHelperPath(await readWorkflow(paths, {}), paths.helper));
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile(paths.bridgeConfig, "utf8")).port)), 0o700);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}

export async function rollback(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  applyOptions(options);
  if (platform() === "win32") return await runWslCli("rollback", options) as LifecyclePaths;
  const paths = lifecyclePaths(process.env, platform());
  await applyStoredTaskName(paths);
  const previous = await readOptional(paths.previousRelease);
  const current = await readOptional(paths.currentRelease);
  if (!previous || !current) throw new LifecycleError("rollback_unavailable", "no previous release is available for rollback");
  await writeAtomic(paths.currentRelease, `${previous}\n`);
  await writeAtomic(paths.previousRelease, `${current}\n`);
  await writeAtomic(paths.wrapper, serviceInvocation(paths, Number(JSON.parse(await readFile(paths.bridgeConfig, "utf8")).port)), 0o700);
  await installUnit(paths);
  if (await serviceStatus(paths, "is-active")) await run("systemctl", ["--user", "restart", paths.serviceName]);
  return paths;
}

export async function uninstall(options: LifecycleOptions = {}): Promise<LifecyclePaths> {
  applyOptions(options);
  if (platform() === "win32") {
    const probe = windowsKeeperPaths(lifecyclePaths(process.env, platform()));
    await applyStoredTaskName(probe);
    const task = await taskOwnership(probe);
    if (task === "foreign") throw new LifecycleError("task_owned_elsewhere", `scheduled task already exists and is not owned by this installation: ${probe.taskName}`);
    const result = await runWslCli("uninstall", options) as LifecyclePaths;
    await removeLinuxMarker(result.enabledMarker);
    if (task === "owned") await runHost("schtasks.exe", ["/Delete", "/TN", probe.taskName, "/F"], true);
    for (const path of [probe.launcher, probe.taskXml, probe.metadata]) await rm(path, { force: true });
    return { ...result, launcher: probe.launcher, taskXml: probe.taskXml, metadata: probe.metadata, taskName: probe.taskName };
  }
  const paths = lifecyclePaths(process.env, platform());
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
