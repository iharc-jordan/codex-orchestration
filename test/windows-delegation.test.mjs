import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function wsl(args) {
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", ...args], { maxBuffer: 1_048_576 });
}

async function writeWslFile(path, content) {
  const encoded = Buffer.from(content).toString("base64");
  await wsl(["bash", "-lc", `printf '%s' '${encoded}' | base64 -d > '${path}' && chmod 755 '${path}'`]);
}

async function waitFor(predicate, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

test("Windows lifecycle delegates service state to WSL and keeps only the host keeper", { skip: process.platform !== "win32" }, async (t) => {
  const root = `/tmp/codex-orchestration-windows-${process.pid}-${Date.now()}`;
  const service = `codex-orchestration-windows-${process.pid}`;
  const secondRoot = `/tmp/codex-orchestration-windows-second-${process.pid}-${Date.now()}`;
  const secondService = `codex-orchestration-windows-second-${process.pid}`;
  const cli = `${process.cwd()}\\mcp\\cli.mjs`;
  let installed = false;
  let secondInstalled = false;
  await wsl(["mkdir", "-p", root]);
  t.after(async () => {
    if (installed) await execFileAsync(process.execPath, [cli, "uninstall", "--root", root, "--service-name", service]).catch(() => undefined);
    if (secondInstalled) await execFileAsync(process.execPath, [cli, "uninstall", "--root", secondRoot, "--service-name", secondService]).catch(() => undefined);
    await wsl(["rm", "-rf", root]).catch(() => undefined);
    await wsl(["rm", "-rf", secondRoot]).catch(() => undefined);
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
  const launcher = await readFile(paths.launcher, "utf8");
  assert.match(launcher, /wsl\.exe -d Ubuntu -- test -f/);
  assert.doesNotMatch(launcher, /Test-Path/);
  const config = JSON.parse((await wsl(["cat", `${root}/config/config.json`])).stdout);
  assert.equal(config.token_file, `${root}/config/token`);
  await access(paths.metadata);

  await wsl(["mkdir", "-p", secondRoot]);
  const secondResult = await execFileAsync(process.execPath, [
    cli,
    "setup",
    "--root",
    secondRoot,
    "--service-name",
    secondService,
    "--executable",
    "/bin/true",
    "--workflow",
    "/etc/hosts",
    "--version",
    "windows-test",
    "--port",
    "18995"
  ], { maxBuffer: 1_048_576 });
  secondInstalled = true;
  const secondPaths = JSON.parse(secondResult.stdout);
  assert.notEqual(secondPaths.metadata, paths.metadata);
  await execFileAsync(process.execPath, [cli, "uninstall", "--root", secondRoot, "--service-name", secondService]);
  secondInstalled = false;
  await access(paths.metadata);
});

test("Windows caller exit leaves the WSL service under the hidden keeper until stop", { skip: process.platform !== "win32" }, async (t) => {
  const root = `/tmp/codex-orchestration-windows-start-${process.pid}-${Date.now()}`;
  const service = `codex-orchestration-windows-start-${process.pid}`;
  const cli = `${process.cwd()}\\mcp\\cli.mjs`;
  const executable = `${root}/input/symphony`;
  const fakeSymphony = `#!/bin/sh
exec python3 - "$@" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

args = sys.argv[1:]
port = int(args[args.index("--port") + 1])

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/v1/managed/state"):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"state":"READY","revision":1,"latest_cursor":0}')
        else:
            self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or "{}")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"accepted": True, "request_id": body.get("request_id")}).encode())

    def log_message(self, *_args):
        pass

HTTPServer(("127.0.0.1", port), Handler).serve_forever()
PY
`;
  let installed = false;
  await wsl(["mkdir", "-p", `${root}/input`]);
  await writeWslFile(executable, fakeSymphony);
  t.after(async () => {
    if (installed) await execFileAsync(process.execPath, [cli, "uninstall", "--root", root, "--service-name", service]).catch(() => undefined);
    await wsl(["rm", "-rf", root]).catch(() => undefined);
  });

  await execFileAsync(process.execPath, [
    cli,
    "setup",
    "--root",
    root,
    "--service-name",
    service,
    "--executable",
    executable,
    "--workflow",
    "/etc/hosts",
    "--version",
    "windows-start-test",
    "--port",
    "18996"
  ], { maxBuffer: 1_048_576 });
  installed = true;
  const startResult = await execFileAsync(process.execPath, [cli, "start", "--root", root, "--service-name", service], { maxBuffer: 1_048_576 });
  const paths = JSON.parse(startResult.stdout);
  const diagnostic = await waitFor(async () => {
    const result = await execFileAsync(process.execPath, [cli, "diagnostics", "--root", root, "--service-name", service], { maxBuffer: 1_048_576 });
    const value = JSON.parse(result.stdout);
    return value.service.active ? value : undefined;
  });
  assert.equal(diagnostic?.service.active, true);
  assert.equal(diagnostic?.paths.config, `${root}/config/config.json`);
  await wsl(["test", "-f", paths.enabledMarker]);
  const runningTask = await waitFor(async () => {
    const result = await execFileAsync("schtasks.exe", ["/Query", "/TN", paths.taskName, "/FO", "LIST"]).catch(() => undefined);
    return result && /running/i.test(result.stdout) ? result : undefined;
  });
  assert.ok(runningTask, "the hidden WSL keeper task should remain running after the caller exits");

  await execFileAsync(process.execPath, [cli, "stop", "--root", root, "--service-name", service], { maxBuffer: 1_048_576 });
  const stopped = JSON.parse((await execFileAsync(process.execPath, [cli, "diagnostics", "--root", root, "--service-name", service], { maxBuffer: 1_048_576 })).stdout);
  assert.equal(stopped.service.active, false);
  await assert.rejects(wsl(["test", "-f", paths.enabledMarker]));
  await execFileAsync(process.execPath, [cli, "uninstall", "--root", root, "--service-name", service], { maxBuffer: 1_048_576 });
  installed = false;
});
