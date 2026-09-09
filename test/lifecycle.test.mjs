import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { toWslPath } from "../dist/paths.js";

const execFileAsync = promisify(execFile);
const pluginPath = process.platform === "win32" ? toWslPath(process.cwd()) : process.cwd();

async function wslNodePath() {
  const { stdout } = await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node -p process.execPath"]);
  return stdout.trim().split(/\r?\n/).filter((line) => line.startsWith("/")).pop();
}

async function wsl(node, args) {
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", node, ...args], { maxBuffer: 1_048_576 });
}

async function wslCommand(args) {
  return execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", ...args], { maxBuffer: 1_048_576 });
}

async function writeWslFile(node, path, content, mode = "600") {
  const script = "const fs=require('node:fs'); const mode=parseInt(process.argv[3],8); fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), { mode }); fs.chmodSync(process.argv[1], mode);";
  await wsl(node, ["-e", script, path, Buffer.from(content).toString("base64"), mode]);
}

async function runCli(node, args) {
  return wsl(node, [`${pluginPath}/mcp/cli.mjs`, ...args]);
}

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
            self.wfile.write(json.dumps({"state": "READY", "revision": 1, "latest_cursor": 0}).encode())
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

test("disposable lifecycle installs, upgrades, rolls back, stops, and uninstalls safely", async (t) => {
  const node = await wslNodePath();
  const root = `/tmp/Codex Orchestration lifecycle ${process.pid}-${Date.now()}`;
  const service = `codex-orchestration-test-${process.pid}`;
  const fake = `${root}/input/symphony`;
  const options = ["--root", root, "--service-name", service];
  let installed = false;
  let uninstalled = false;
  await wslCommand(["mkdir", "-p", `${root}/input`]);
  await writeWslFile(node, fake, fakeSymphony, "755");
  t.after(async () => {
    if (installed && !uninstalled) {
      await wslCommand(["systemctl", "--user", "disable", "--now", `${service}.service`]);
    }
    await wslCommand(["rm", "-rf", root]);
    await wslCommand(["systemctl", "--user", "daemon-reload"]);
  });

  const setup = JSON.parse((await runCli(node, ["setup", ...options, "--executable", fake, "--workflow", "/etc/hosts", "--version", "r1", "--port", "18991"])).stdout);
  installed = true;
  assert.match(setup.wrapper, /Codex Orchestration lifecycle/);
  const unit = await wslCommand(["cat", setup.unit]);
  assert.match(unit.stdout, /flock|KillMode=control-group/);
  const wrapper = await wslCommand(["cat", setup.wrapper]);
  assert.match(wrapper.stdout, /--nonblock/);
  assert.match(wrapper.stdout, /--managed/);
  const diagnostic = JSON.parse((await runCli(node, ["diagnostics", ...options])).stdout);
  assert.equal(diagnostic.service.enabled, false);
  assert.equal(diagnostic.release.endsWith("/r1/symphony"), true);

  await runCli(node, ["start", ...options]);
  const active = await runCli(node, ["diagnostics", ...options]);
  assert.equal(JSON.parse(active.stdout).service.active, true);
  await runCli(node, ["pause", ...options]);
  await runCli(node, ["resume", ...options]);

  await runCli(node, ["upgrade", ...options, "--executable", fake, "--version", "r2"]);
  const upgraded = JSON.parse((await runCli(node, ["diagnostics", ...options])).stdout);
  assert.equal(upgraded.release.endsWith("/r2/symphony"), true);
  assert.equal(upgraded.previousRelease.endsWith("/r1/symphony"), true);

  await runCli(node, ["rollback", ...options]);
  const rolledBack = JSON.parse((await runCli(node, ["diagnostics", ...options])).stdout);
  assert.equal(rolledBack.release.endsWith("/r1/symphony"), true);
  assert.equal(rolledBack.previousRelease.endsWith("/r2/symphony"), true);

  await runCli(node, ["stop", ...options]);
  const stopped = JSON.parse((await runCli(node, ["diagnostics", ...options])).stdout);
  assert.equal(stopped.service.active, false);
  await runCli(node, ["uninstall", ...options]);
  uninstalled = true;
  await wslCommand(["test", "-f", `${root}/config/config.json`]);
  await wslCommand(["test", "-d", `${root}/state/journal`]);
  await wslCommand(["test", "-d", `${root}/state/workspaces`]);
  const linkedUnits = await wslCommand(["systemctl", "--user", "list-unit-files", "--no-legend"]);
  assert.doesNotMatch(linkedUnits.stdout, new RegExp(`${service}\\.service`));
});
