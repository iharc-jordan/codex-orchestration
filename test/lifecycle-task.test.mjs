import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lifecycleRunOutcomeIsUncertain, lifecycleTaskArguments, lifecycleTaskXml, quoteWindowsArgument, runLifecycleViaTask } from "../dist/lifecycle_task.js";

const exec = promisify(execFile);

test("one-shot task uses direct Node execution and preserves Windows argv boundaries", () => {
  assert.equal(quoteWindowsArgument("plain"), "plain");
  assert.equal(quoteWindowsArgument("C:\\with space\\cli.mjs"), '"C:\\with space\\cli.mjs"');
  assert.equal(quoteWindowsArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsArgument("C:\\tail space\\"), '"C:\\tail space\\\\"');
  const args = lifecycleTaskArguments("C:\\plugin path\\mcp\\cli.mjs", "C:\\request path\\request.json", "abc123");
  assert.equal(args, '"C:\\plugin path\\mcp\\cli.mjs" --lifecycle-task-child "C:\\request path\\request.json" abc123');
  const xml = lifecycleTaskXml("C:\\Program Files\\nodejs\\node.exe", "C:\\plugin path\\mcp\\cli.mjs", "C:\\request path\\request.json", "abc123", "S-1-5-21-1");
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<Triggers \/>/);
  assert.doesNotMatch(xml, /GITHUB_TOKEN|CODEX_ORCHESTRATION_HOME/);
  assert.equal(lifecycleRunOutcomeIsUncertain(true, false), true, "accepted-then-timeout is uncertain and must not replay");
  assert.equal(lifecycleRunOutcomeIsUncertain(true, true), false);
  assert.equal(lifecycleRunOutcomeIsUncertain(false, false), false);
});

test("one-shot task writes and attests the physical LocalAppData files, then leaves no task", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only integration");
  const id = randomUUID().replaceAll("-", "");
  const fixture = join(process.env.USERPROFILE, ".codex", "orchestration-lifecycle-test-" + id);
  const root = join(process.env.LOCALAPPDATA, "CodexOrchestrationTaskBridgeTest-" + id);
  const mcp = join(fixture, "mcp");
  const manifest = join(fixture, ".codex-plugin");
  const cli = join(mcp, "cli.mjs");
  const implementation = pathToFileURL(resolve("dist/lifecycle_task.js")).href;
  await mkdir(mcp, { recursive: true });
  await mkdir(manifest, { recursive: true });
  await writeFile(join(manifest, "plugin.json"), "{}\n", "utf8");
  await writeFile(cli, [
    `import { runLifecycleTaskChild } from ${JSON.stringify(implementation)};`,
    'import { mkdir, writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    `const testRoot = ${JSON.stringify(root)};`,
    'const [, , childFlag, request, nonce] = process.argv;',
    'if (childFlag !== "--lifecycle-task-child") throw new Error("invalid child flag");',
    'process.exitCode = await runLifecycleTaskChild(request, nonce, async () => {',
    '  const root = testRoot;',
    '  const config = join(root, "config");',
    '  await mkdir(config, { recursive: true });',
    '  await writeFile(join(config, "config.json"), "{}\\n", "utf8");',
    '  await writeFile(join(config, "token"), "proof\\n", "utf8");',
    '  return { proof: "physical-local-appdata" };',
    '}, testRoot);', ''
  ].join("\n"), "utf8");
  t.after(async () => {
    await rm(fixture, { recursive: true, force: true });
    try {
      if (realpathSync.native(root).toLocaleLowerCase("en-US") === resolve(root).toLocaleLowerCase("en-US")) {
        await rm(root, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  });

  assert.equal(await runLifecycleViaTask(cli, ["setup"], root), 0);
  assert.equal(realpathSync.native(root).toLocaleLowerCase("en-US"), resolve(root).toLocaleLowerCase("en-US"));
  assert.equal(await readFile(join(root, "config", "token"), "utf8"), "proof\n");
  const tasks = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$count = @(Get-ScheduledTask -ErrorAction Stop | Where-Object TaskName -like 'Codex-Orchestration-Lifecycle-*').Count; [Console]::WriteLine($count)"], { windowsHide: true });
  assert.equal(tasks.stdout.trim(), "0");
});
