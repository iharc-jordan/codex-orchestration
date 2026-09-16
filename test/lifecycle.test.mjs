import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { orchestrationPaths } from "../dist/paths.js";
import { boundedStartupLogCause, configuredWorkflow, freshStartupLogCause, privateDirectory, resolveCodexLauncher, runnerContent, scheduledTaskXml, scrubControllerEnvironment, validateReleaseManifest, workerCommand } from "../dist/lifecycle.js";

const execFile = promisify(execFileCallback);

test("startup diagnostics surface only the bounded terminal BEAM atom", () => {
  assert.equal(boundedStartupLogCause("Application exited: ** (EXIT) :missing_github_projects_token"), "missing_github_projects_token");
  assert.equal(boundedStartupLogCause("secret=do-not-return\nordinary failure"), undefined);
  assert.equal(freshStartupLogCause("** (EXIT) :missing_github_projects_token", 1_999, 2_000), undefined);
  assert.equal(freshStartupLogCause("** (EXIT) :missing_github_projects_token", 2_000, 2_000), "missing_github_projects_token");
});

test("one path resolver keeps private Windows state below CodexOrchestration", () => {
  const paths = orchestrationPaths({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local", CODEX_ORCHESTRATION_HOME: "D:\\hidden-override" });
  assert.equal(paths.root, "C:\\Users\\Test\\AppData\\Local\\CodexOrchestration");
  for (const path of [paths.releases, paths.config, paths.state, paths.logs, paths.workspaces, paths.current, paths.previous, paths.bridgeConfig, paths.controllerEnvironment]) assert.ok(path.startsWith(paths.root + "\\"));
  assert.doesNotMatch(JSON.stringify(paths), /wsl|systemd|linux/i);
});

test("private directory hardening recovers an owner-correct child with an empty ACL", async (t) => {
  if (process.platform !== "win32") { t.skip("native Windows ACL recovery"); return; }
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-acl-"));
  const child = join(root, "interrupted-release");
  await mkdir(join(child, "nested"), { recursive: true });
  const identity = await execFile("whoami.exe", ["/user"], { windowsHide: true });
  const sid = identity.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  assert.ok(sid, "current Windows SID must be available");
  t.after(async () => {
    await execFile("icacls.exe", [root, "/grant:r", "*" + sid + ":(OI)(CI)F"], { windowsHide: true }).catch(() => undefined);
    await execFile("icacls.exe", [root, "/grant:r", "*" + sid + ":F", "/t", "/c"], { windowsHide: true }).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await execFile("icacls.exe", [child, "/inheritance:r", "/grant:r", "*" + sid + ":F"], { windowsHide: true });
  await execFile("icacls.exe", [child, "/remove:g", "*" + sid], { windowsHide: true });
  await privateDirectory(root);
  const listing = await execFile("icacls.exe", [root, "/t", "/c"], { windowsHide: true });
  assert.doesNotMatch(listing.stdout + listing.stderr, /Failed processing\s+[1-9]/i);
  assert.match(listing.stdout, /interrupted-release[\\/]nested/);
});

test("worker App Server command uses the public npm shim through cmd.exe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-launcher-"));
  const launcher = join(root, "codex.cmd"); await writeFile(launcher, "@echo off\r\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await resolveCodexLauncher(launcher), launcher);
  assert.throws(() => workerCommand("relative\\codex.cmd"), /absolute Windows path/);
  assert.deepEqual(workerCommand(launcher), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "\"\"" + launcher + "\" app-server -c features.multi_agent=false -c features.multi_agent_v2=false\""]
  });
});

test("worker secrets and task identity are removed case-insensitively without stripping worker profile discovery", () => {
  const clean = scrubControllerEnvironment({
    PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\Test", APPDATA: "C:\\Users\\Test\\AppData\\Roaming", CODEX_HOME: "C:\\Users\\Test\\.codex",
    github_TOKEN: "secret", codex_THREAD_id: "thread", SYMPHONY_TASK_ID: "task", SYMPHONY_UNEXPECTED: "unexpected", NORMAL_WORKER_SETTING: "ok"
  });
  assert.equal(clean.github_TOKEN, undefined); assert.equal(clean.codex_THREAD_id, undefined); assert.equal(clean.SYMPHONY_TASK_ID, undefined); assert.equal(clean.SYMPHONY_UNEXPECTED, undefined);
  assert.equal(clean.PATH, "C:\\Windows"); assert.equal(clean.USERPROFILE, "C:\\Users\\Test"); assert.equal(clean.CODEX_HOME, "C:\\Users\\Test\\.codex"); assert.equal(clean.NORMAL_WORKER_SETTING, "ok");
});

test("workflow replaces legacy command and args with the validated launcher", () => {
  const launcher = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
  const workflow = "workspace:\n  root: C:\\work\ncodex:\n  command: codex app-server\n  args:\n    - legacy\n  approval_policy: never\nmanaged:\n  enabled: true\n";
  const configured = configuredWorkflow(workflow, launcher);
  assert.match(configured, /launcher:/); assert.match(configured, /codex\.cmd/);
  assert.doesNotMatch(configured, /command:/); assert.doesNotMatch(configured, /args:/);
  assert.match(configured, /approval_policy: never/);
});

test("workflow updater preserves four-space settings, inline maps, and the body", () => {
  const launcher = "C:\\Users\\Test\\AppData\\Roaming\\npm\\codex.cmd";
  const content = "---\nname: preserved\ncodex: { command: codex, args: [legacy, { mode: old }], approval_policy: never, nested: { keep: true } }\nother:\n    value: yes\n---\n\nBody stays byte-for-byte.\n";
  const configured = configuredWorkflow(content, launcher);
  assert.match(configured, /^codex: \{ launcher: "C:\\\\Users\\\\Test\\\\AppData\\\\Roaming\\\\npm\\\\codex\.cmd", approval_policy: never, nested: \{ keep: true \} \}$/m);
  assert.doesNotMatch(configured, /command:/); assert.doesNotMatch(configured, /args:/); assert.match(configured, /other:\n    value: yes/); assert.match(configured, /Body stays byte-for-byte\./);

  const fourSpace = "codex:\n    approval_policy: never\n    args:\n      - old\n    provider:\n      token: $GITHUB_TOKEN\nmanaged:\n    enabled: true\n";
  const updated = configuredWorkflow(fourSpace, launcher);
  assert.match(updated, /codex:\n    launcher:/); assert.match(updated, /    approval_policy: never/); assert.match(updated, /    provider:\n      token: \$GITHUB_TOKEN/); assert.match(updated, /managed:\n    enabled: true/); assert.doesNotMatch(updated, /args:/);
});

test("native task and runner have the required Windows lifecycle contract", () => {
  const paths = { ...orchestrationPaths({ LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" }), taskName: "CodexOrchestration", workflow: "C:\\Users\\Test\\AppData\\Local\\CodexOrchestration\\config\\WORKFLOW.md" };
  const task = scheduledTaskXml(paths, "S-1-5-21-123");
  assert.match(task, /InteractiveToken/); assert.match(task, /LeastPrivilege/); assert.match(task, /LogonTrigger/);
  assert.match(task, /<Hidden>true<\/Hidden>/); assert.match(task, /<ExecutionTimeLimit>PT0S/); assert.match(task, /IgnoreNew/); assert.match(task, /<Interval>PT1M<\/Interval><Count>3<\/Count>/);
  assert.match(task, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/); assert.match(task, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(task, /<Command>powershell\.exe<\/Command>/); assert.match(task, /-WindowStyle Hidden/); assert.match(task, /-File &quot;.*run-orchestration\.ps1&quot;/);
  assert.doesNotMatch(task, /<Command>cmd\.exe<\/Command>/);
  const runner = runnerContent(paths, 8787);
  for (const name of ["SYMPHONY_WORKFLOW_PATH", "SYMPHONY_LOGS_ROOT", "SYMPHONY_STATE_ROOT", "SYMPHONY_WORKSPACES_ROOT", "SYMPHONY_CONTROL_TOKEN_FILE", "SYMPHONY_WINDOWS_WORKER_HOST", "SYMPHONY_SERVER_HOST", "SYMPHONY_SERVER_PORT", "SYMPHONY_MANAGED"]) assert.match(runner, new RegExp(name));
  assert.match(runner, /ConvertFrom-Json/); assert.match(runner, /\$bridge\.port/); assert.doesNotMatch(runner, /SYMPHONY_SERVER_PORT = '8787'/);
  assert.match(runner, /bin\\symphony\.bat/); assert.match(runner, /RELEASE_DISTRIBUTION = 'none'/);
  assert.match(runner, /CodexOrchestrationController/); assert.match(runner, /controller-process\.json/);
  assert.match(runner, /SYMPHONY_WINDOWS_WORKER_HOST @controllerArgs/); assert.doesNotMatch(runner, /& \$entry start/);
});

test("runner resolves private controller provider auth for the native controller", async (t) => {
  if (process.platform !== "win32") { t.skip("native Windows runner"); return; }
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { ...orchestrationPaths({}, root), taskName: "CodexOrchestrationRunnerTest", workflow: join(root, "config", "WORKFLOW.md") };
  const release = join(paths.releases, "0.4.0", "bin"); const output = join(root, "controller-env.txt");
  await mkdir(release, { recursive: true }); await mkdir(paths.config, { recursive: true });
  await writeFile(paths.current, "0.4.0\n"); await writeFile(paths.token, "bridge-secret\n");
  await writeFile(paths.bridgeConfig, JSON.stringify({ host: "127.0.0.1", port: 8787, token_file: paths.token }));
  await writeFile(paths.controllerEnvironment, JSON.stringify({ GITHUB_TOKEN: "private-controller-token" }));
  const helper = join(release, "symphony-worker-host.exe");
  const helperSource = "using System; using System.IO; public static class Fixture { public static int Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable(\"CODEX_ORCHESTRATION_TEST_OUTPUT\"), (Environment.GetEnvironmentVariable(\"GITHUB_TOKEN\") ?? \"\") + \"__\" + (Environment.GetEnvironmentVariable(\"SYMPHONY_TASK_ID\") ?? \"\")); return 0; } }";
  const encodedSource = Buffer.from(helperSource, "utf16le").toString("base64");
  const compileHelper = "$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encodedSource + "')); Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly '" + helper.replaceAll("'", "''") + "' -OutputType ConsoleApplication";
  await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", compileHelper], { windowsHide: true });
  await writeFile(join(release, "symphony.bat"), "@echo off\r\nexit /b 0\r\n");
  await writeFile(paths.runner, runnerContent(paths, 8787));
  await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.runner], { windowsHide: true, env: { ...process.env, CODEX_ORCHESTRATION_TEST_OUTPUT: output, GITHUB_TOKEN: "inherited-stale-token", SYMPHONY_TASK_ID: "spoofed-task" } });
  assert.equal((await readFile(output, "utf8")).trim(), "private-controller-token__");
  await writeFile(paths.controllerEnvironment, JSON.stringify({ GITHUB_TOKEN: "private-controller-token", sYmPhOnY_tAsK_iD: "spoofed-private-task" }));
  await assert.rejects(() => execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", paths.runner], { windowsHide: true }), /invalid controller environment/i);
});

test("release manifests pin the approved GitHub release and a SHA-256", () => {
  const manifest = { repository: "iharc-jordan/symphony", version: "0.4.0", runtimeDownloadUrl: "https://github.com/iharc-jordan/symphony/releases/download/v0.4.0/symphony-windows.zip", sha256: "a".repeat(64), distribution: "none", cookieFile: "absent" };
  assert.deepEqual(validateReleaseManifest(manifest), manifest);
  assert.throws(() => validateReleaseManifest({ ...manifest, runtimeDownloadUrl: "https://example.invalid/release.zip" }), /GitHub release/);
  assert.throws(() => validateReleaseManifest({ ...manifest, sha256: "not-a-digest" }), /SHA-256/);
  assert.throws(() => validateReleaseManifest({ ...manifest, distribution: "sname" }), /distribution/);
});

test("published plugin bundles the paired runtime manifest when the release owner has supplied it", async (t) => {
  const manifest = JSON.parse(await readFile(new URL("../release-manifest.json", import.meta.url), "utf8"));
  if (manifest.version !== "0.4.0") {
    t.skip("the release owner supplies the paired 0.4.0 runtime manifest");
    return;
  }
  const validated = validateReleaseManifest(manifest);
  assert.equal(validated.repository, "iharc-jordan/symphony");
  assert.equal(validated.version, "0.4.0");
  assert.match(validated.runtimeDownloadUrl, /^https:\/\/github\.com\/iharc-jordan\/symphony\/releases\/download\/v0\.4\.0\//);
  assert.match(validated.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/i);
});
