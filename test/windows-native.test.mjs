import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { orchestrationPaths } from "../dist/paths.js";
import { scheduledTaskXml, stopOwnedTask } from "../dist/lifecycle.js";

const execFile = promisify(execFileCallback);
const native = { skip: process.platform !== "win32" };

async function run(command, args, allowFailure = false) {
  try { return await execFile(command, args, { windowsHide: true, maxBuffer: 1_048_576 }); }
  catch (error) { if (allowFailure) return error; throw error; }
}
async function currentSid() {
  const result = await run("whoami.exe", ["/user"]);
  const sid = result.stdout.match(/S-[0-9-]+/)?.[0];
  assert.ok(sid, "native fixture requires a current Windows SID");
  return sid;
}
async function taskState(taskName) {
  const escaped = taskName.replaceAll("'", "''");
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$task = Get-ScheduledTask -TaskName '" + escaped + "' -ErrorAction SilentlyContinue; if ($null -eq $task) { '-1' } else { [int]$task.State }"]);
  return Number.parseInt(result.stdout.trim(), 10);
}
async function taskSettings(taskName) {
  const escaped = taskName.replaceAll("'", "''");
  const script = "$task = Get-ScheduledTask -TaskName '" + escaped + "' -ErrorAction Stop; $s = $task.Settings; ConvertTo-Json -Compress @{ disallowStartIfOnBatteries = [bool]$s.DisallowStartIfOnBatteries; stopIfGoingOnBatteries = [bool]$s.StopIfGoingOnBatteries; hidden = [bool]$s.Hidden; multipleInstances = [string]$s.MultipleInstances; executionTimeLimit = [string]$s.ExecutionTimeLimit }";
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  return JSON.parse(result.stdout.trim());
}

test("native stop reads Get-ScheduledTask state and stops an actually running owned task", native, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-task-"));
  const taskName = "CodexOrchestrationNative-" + process.pid + "-" + Date.now().toString(36);
  assert.notEqual(taskName, "CodexOrchestration");
  const base = orchestrationPaths({}, root);
  const paths = { ...base, taskName, workflow: join(base.config, "WORKFLOW.md") };
  let created = false;
  t.after(async () => {
    if (created) {
      await run("schtasks.exe", ["/End", "/TN", taskName], true);
      await run("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], true);
    }
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(paths.runner, "Start-Sleep -Seconds 120\r\n", "utf8");
  await writeFile(paths.metadata, JSON.stringify({ taskName, root: paths.root }) + "\n", "utf8");
  await writeFile(paths.taskXml, Buffer.from("\uFEFF" + scheduledTaskXml(paths, await currentSid()), "utf16le"));
  await run("schtasks.exe", ["/Create", "/TN", taskName, "/XML", paths.taskXml, "/F"]);
  created = true;
  const settings = await taskSettings(taskName);
  assert.equal(settings.disallowStartIfOnBatteries, false);
  assert.equal(settings.stopIfGoingOnBatteries, false);
  assert.equal(settings.hidden, true);
  assert.equal(settings.multipleInstances, "IgnoreNew");
  assert.equal(settings.executionTimeLimit, "PT0S");
  await run("schtasks.exe", ["/Run", "/TN", taskName]);
  const runningDeadline = Date.now() + 20_000;
  let state = -1;
  while (Date.now() < runningDeadline) {
    state = await taskState(taskName);
    if (state === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(state, 4, "disposable scheduled task must be observed actually running");
  await stopOwnedTask(paths);
  const stoppedDeadline = Date.now() + 15_000;
  while (Date.now() < stoppedDeadline) {
    state = await taskState(taskName);
    if (state !== 2 && state !== 4) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.notEqual(state, 4, "owned task must no longer be running after stop");
  assert.notEqual(state, 2, "owned task must no longer be queued after stop");
  assert.match(await readFile(paths.metadata, "utf8"), new RegExp(taskName));
});
