import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function wsl(args) {
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", ...args], { maxBuffer: 1_048_576 });
}

test("Windows lifecycle delegates service state to WSL and keeps only the host keeper", { skip: process.platform !== "win32" }, async (t) => {
  const root = `/tmp/codex-orchestration-windows-${process.pid}-${Date.now()}`;
  const service = `codex-orchestration-windows-${process.pid}`;
  const cli = `${process.cwd()}\\mcp\\cli.mjs`;
  let installed = false;
  await wsl(["mkdir", "-p", root]);
  t.after(async () => {
    if (installed) await execFileAsync(process.execPath, [cli, "uninstall", "--root", root, "--service-name", service]).catch(() => undefined);
    await wsl(["rm", "-rf", root]).catch(() => undefined);
  });

  const result = await execFileAsync(process.execPath, [
    cli,
    "setup",
    "--root",
    root,
    "--service-name",
    service,
    "--executable",
    "/bin/true",
    "--workflow",
    "/etc/hosts",
    "--version",
    "windows-test",
    "--port",
    "18994"
  ], { maxBuffer: 1_048_576 });
  installed = true;
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.configRoot, `${root}/config`);
  assert.equal(paths.stateRoot, `${root}/state`);
  assert.match(paths.launcher, /^[A-Za-z]:\\/);
  assert.match(paths.taskXml, /^[A-Za-z]:\\/);
  assert.match(paths.metadata, /^[A-Za-z]:\\/);
  const config = JSON.parse((await wsl(["cat", `${root}/config/config.json`])).stdout);
  assert.equal(config.token_file, `${root}/config/token`);
  await access(paths.metadata);
});
