import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { ManagedClient } from "../dist/client.js";
import { validateConfig } from "../dist/config.js";
import { toWslPath } from "../dist/paths.js";

const execFileAsync = promisify(execFile);

async function resolveWslNode() {
  const { stdout } = await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lic", "node -p process.execPath"]);
  const value = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!value || !value.startsWith("/")) throw new Error("WSL login environment did not resolve a Linux Node runtime");
  return value;
}

async function writeWslFile(path, contents, wslNode) {
  const script = "const fs=require('node:fs'); fs.writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'), { mode: 0o600 });";
  await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", wslNode, "-e", script, path, Buffer.from(contents).toString("base64")]);
}

async function removeWslPath(path) {
  await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "/bin/rm", "-rf", path]);
}

async function closeFixture(fixture) {
  if (!fixture.listening) return;
  await new Promise((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
}

async function startFixture(token, host = "127.0.0.1") {
  const seen = [];
  let rejectAuth = false;
  let errorCode = "unauthorized";
  let errorStatus = 401;
  let redirect = false;
  let overflow = false;
  const fixture = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    seen.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (rejectAuth || request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = errorStatus;
      response.end(JSON.stringify({ error: { code: errorCode, detail: token } }));
      return;
    }
    if (redirect && request.url?.startsWith("/api/v1/managed/state")) {
      response.statusCode = 302;
      response.setHeader("location", "/api/v1/managed/state");
      response.end();
      return;
    }
    if (overflow && request.url?.startsWith("/api/v1/managed/state")) {
      response.end("x".repeat(1_048_577));
      return;
    }
    if (request.url?.startsWith("/api/v1/managed/state")) {
      response.end(JSON.stringify({ state: "READY", revision: 9, latest_cursor: 7 }));
      return;
    }
    if (request.url?.startsWith("/api/v1/managed/events")) {
      response.end(JSON.stringify({ events: [], latest_cursor: 7 }));
      return;
    }
    if (request.url === "/api/v1/managed/control") {
      if (body.request_id === "stale-1") {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: { code: "stale_revision", detail: token } }));
        return;
      }
      response.end(JSON.stringify({ accepted: true, request_id: body.request_id }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found" } }));
  });
  fixture.listen(0, host);
  await once(fixture, "listening");
  return {
    fixture,
    seen,
    port: fixture.address().port,
    setRejectAuth: (value) => { rejectAuth = value; },
    setErrorCode: (value) => { errorCode = value; },
    setErrorStatus: (value) => { errorStatus = value; },
    setRedirect: (value) => { redirect = value; },
    setOverflow: (value) => { overflow = value; }
  };
}

function readJsonLines(child) {
  let buffer = "";
  const pending = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const index = pending.findIndex((entry) => entry.id === message.id);
      if (index >= 0) pending.splice(index, 1)[0].resolve(message);
    }
  });
  return (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.push({ id, resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}`)), 10_000);
    const entry = pending[pending.length - 1];
    entry.resolve = (message) => { clearTimeout(timer); resolve(message); };
  });
}

test("bundled stdio bridge performs authenticated state, events, and controls", async (t) => {
  const token = "fixture-secret-token";
  const wslNode = process.platform === "win32" ? await resolveWslNode() : undefined;
  const root = process.platform === "win32"
    ? `/tmp/codex-orchestration-test-${process.pid}-${Date.now()}`
    : realpathSync.native(await mkdtemp(join(tmpdir(), "codex-orchestration-test-")));
  const tokenFile = process.platform === "win32" ? `${root}/token` : join(root, "token");
  const configFile = process.platform === "win32" ? `${root}/config.json` : join(root, "config.json");
  const upstream = await startFixture(token);
  const bridgeTokenFile = tokenFile;
  const bridgeConfigFile = configFile;
  const config = JSON.stringify({ host: "127.0.0.1", port: upstream.port, token_file: bridgeTokenFile });
  if (process.platform === "win32") {
    await execFileAsync("wsl.exe", ["-d", "Ubuntu", "--", "/bin/mkdir", "-p", root]);
    await writeWslFile(tokenFile, `${token}\n`, wslNode);
    await writeWslFile(configFile, config, wslNode);
  } else {
    await writeFile(tokenFile, `${token}\n`);
    await chmod(tokenFile, 0o600);
    await writeFile(configFile, config);
  }
  const child = spawn(process.execPath, [join(process.cwd(), "mcp/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_ORCHESTRATION_CONFIG: bridgeConfigFile },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
    await closeFixture(upstream.fixture);
    if (process.platform === "win32") await removeWslPath(root);
    else await rm(root, { recursive: true, force: true });
  });

  const request = readJsonLines(child);
  const initialized = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "codex-orchestration");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const listed = await request(2, "tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "orchestration_diagnostics", "orchestration_state", "orchestration_events",
    "orchestration_bind_project", "orchestration_enroll", "orchestration_revise",
    "orchestration_pause", "orchestration_resume", "orchestration_interrupt",
    "orchestration_cancel", "orchestration_review"
  ]);
  const listedTools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  const operationRequirements = {
    orchestration_bind_project: ["expected_revision", "project"],
    orchestration_enroll: ["expected_revision", "assignment_id", "repository", "issue_number", "base_commit", "board_state", "resources", "dependencies", "route", "requirements_fingerprint", "requirements_revision"],
    orchestration_revise: ["expected_revision", "assignment_id", "changes"],
    orchestration_pause: ["expected_revision"],
    orchestration_resume: ["expected_revision"],
    orchestration_interrupt: ["expected_revision", "assignment_id", "reason"],
    orchestration_cancel: ["expected_revision", "assignment_id"],
    orchestration_review: ["expected_revision", "assignment_id", "disposition"]
  };
  for (const [name, required] of Object.entries(operationRequirements)) {
    const schema = listedTools.get(name).inputSchema;
    assert.deepEqual(schema.required, ["request_id", "args"]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.args.required, required);
  }
  assert.deepEqual(listedTools.get("orchestration_review").inputSchema.properties.args.properties.disposition.enum, ["accepted", "rework", "waiting", "blocked"]);
  assert.deepEqual(listedTools.get("orchestration_enroll").inputSchema.properties.args.properties.route.properties.model.enum, ["gpt-5.6-luna", "gpt-5.6-terra"]);
  const enrollSchema = listedTools.get("orchestration_enroll").inputSchema.properties.args.properties;
  assert.equal(enrollSchema.escalation_reason.type, "string");
  assert.equal(enrollSchema.route.properties.reason, undefined);
  assert.equal(enrollSchema.native_issue_id.type, "string");
  assert.equal(listedTools.get("orchestration_revise").inputSchema.properties.args.properties.changes.properties.escalation_reason.type, "string");

  const state = await request(3, "tools/call", { name: "orchestration_state", arguments: {} });
  assert.deepEqual(JSON.parse(state.result.content[0].text), { state: "READY", revision: 9, latest_cursor: 7 });
  const events = await request(4, "tools/call", { name: "orchestration_events", arguments: { after: 7, wait_ms: 42, limit: 100 } });
  assert.deepEqual(JSON.parse(events.result.content[0].text), { events: [], latest_cursor: 7 });
  assert.equal(new URL(upstream.seen[1].url, "http://127.0.0.1").search, "?after=7&wait_ms=42&limit=100");

  const missingArgs = await request(5, "tools/call", { name: "orchestration_pause", arguments: { request_id: "missing-args" } });
  assert.equal(missingArgs.result.isError, true);
  assert.match(missingArgs.result.content[0].text, /args is required/);

  const pauseArguments = { request_id: "pause-1", args: { expected_revision: 9, reason: "fixture" } };
  await request(6, "tools/call", { name: "orchestration_pause", arguments: pauseArguments });
  await request(7, "tools/call", { name: "orchestration_pause", arguments: pauseArguments });
  const writes = upstream.seen.filter((entry) => entry.method === "POST");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(writes[0].body.request_id, "pause-1");
  assert.equal(writes[0].body.args.expected_revision, 9);

  const stale = await request(8, "tools/call", { name: "orchestration_enroll", arguments: { request_id: "stale-1", args: { expected_revision: 8 } } });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /stale_revision/);
  assert.doesNotMatch(stale.result.content[0].text, new RegExp(token));

  upstream.setRejectAuth(true);
  const unauthorized = await request(9, "tools/call", { name: "orchestration_state", arguments: {} });
  assert.equal(unauthorized.result.isError, true);
  assert.doesNotMatch(unauthorized.result.content[0].text, new RegExp(token));
});

test("client rejects redirects, handles IPv6 loopback, bounds responses, and redacts error codes", async (t) => {
  const token = "fixture-secret-token";
  const upstream = await startFixture(token);
  const client = new ManagedClient({ host: "127.0.0.1", port: upstream.port, tokenFile: "unused", maxInputBytes: 16 * 1024 }, token);
  t.after(() => closeFixture(upstream.fixture));

  upstream.setRedirect(true);
  await assert.rejects(() => client.state(), (error) => error.code === "upstream_unreachable");
  upstream.setRedirect(false);
  const ipv6 = await startFixture(token, "::1");
  t.after(() => closeFixture(ipv6.fixture));
  const ipv6Client = new ManagedClient({ host: "::1", port: ipv6.port, tokenFile: "unused", maxInputBytes: 16 * 1024 }, token);
  assert.deepEqual(await ipv6Client.state(), { state: "READY", revision: 9, latest_cursor: 7 });

  upstream.setOverflow(true);
  await assert.rejects(() => client.state(), (error) => error.code === "upstream_response_too_large");
  upstream.setOverflow(false);
  upstream.setRejectAuth(true);
  upstream.setErrorCode(token);
  upstream.setErrorStatus(409);
  const unauthorized = await assert.rejects(() => client.state(), (error) => {
    assert.equal(error.code, "upstream_error");
    assert.equal(error.message, "Symphony request failed with HTTP 409");
    assert.doesNotMatch(error.message, new RegExp(token));
    return true;
  });
  assert.equal(unauthorized, undefined);
});

test("configuration validation rejects non-loopback and broad token permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-config-"));
  const tokenFile = join(root, "token");
  const configFile = join(root, "config.json");
  await writeFile(tokenFile, "secret");
  await writeFile(configFile, JSON.stringify({ host: "10.0.0.1", port: 1234, token_file: tokenFile }));
  process.env.CODEX_ORCHESTRATION_CONFIG = configFile;
  assert.equal((await validateConfig()).valid, false);
  if (process.platform !== "win32") {
    await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port: 1234, token_file: tokenFile }));
    await chmod(tokenFile, 0o644);
    assert.match((await validateConfig()).error, /permissions/);
  }
  delete process.env.CODEX_ORCHESTRATION_CONFIG;
  await rm(root, { recursive: true, force: true });
});

test("Windows launcher conversion preserves spaces without shell interpolation", () => {
  assert.equal(toWslPath("C:\\Users\\Jordan Stevenson\\Codex Orchestration\\mcp\\server.mjs"), "/mnt/c/Users/Jordan Stevenson/Codex Orchestration/mcp/server.mjs");
  assert.throws(() => toWslPath("\\\\server\\share\\server.mjs"), /local Windows drive/);
});
