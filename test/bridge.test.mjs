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
import { ManagedClient, derivePmCredential } from "../dist/client.js";
import { validateConfig } from "../dist/config.js";
import { assertMcpEntrypoint, toWslPath } from "../dist/paths.js";

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

async function startFixture(token, host = "127.0.0.1", acceptedTokens = [token]) {
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
    if (rejectAuth || !acceptedTokens.some((accepted) => request.headers.authorization === `Bearer ${accepted}`)) {
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

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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
  const threadId = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d72";
  const upstream = await startFixture(token, "127.0.0.1", [token, derivePmCredential(token, threadId)]);
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
    "orchestration_register_pm", "orchestration_claim", "orchestration_enroll", "orchestration_revise",
    "orchestration_pause", "orchestration_resume", "orchestration_interrupt",
    "orchestration_cancel", "orchestration_review", "orchestration_handoff"
  ]);
  const listedTools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  const operationRequirements = {
    orchestration_register_pm: [],
    orchestration_claim: ["project_id", "assignment_id", "expected_revision", "expected_ownership_revision"],
    orchestration_enroll: ["expected_revision", "project_id", "assignment_id", "repository", "issue_number", "base_commit", "board_state", "resources", "dependencies", "route", "requirements_fingerprint", "requirements_revision"],
    orchestration_revise: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "changes"],
    orchestration_pause: ["scope", "project_id", "assignments"],
    orchestration_resume: ["scope", "project_id", "assignments"],
    orchestration_interrupt: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "reason"],
    orchestration_cancel: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id"],
    orchestration_review: ["expected_revision", "expected_ownership_revision", "project_id", "assignment_id", "disposition"],
    orchestration_handoff: ["project_id", "assignments", "destination_pm_id", "reason"]
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

  const metadata = { threadId, "x-codex-turn-metadata": { thread_id: threadId } };
  const missingArgs = await request(5, "tools/call", { name: "orchestration_pause", _meta: metadata, arguments: { request_id: "missing-args" } });
  assert.equal(missingArgs.result.isError, true);
  assert.match(missingArgs.result.content[0].text, /args is required/);

  const pauseArguments = { request_id: "pause-1", args: { scope: "assignments", project_id: "project-1", assignments: [{ assignment_id: "assignment-1", expected_revision: 9, expected_ownership_revision: 0 }], reason: "fixture" } };
  await request(6, "tools/call", { name: "orchestration_pause", _meta: metadata, arguments: pauseArguments });
  await request(7, "tools/call", { name: "orchestration_pause", _meta: metadata, arguments: pauseArguments });
  const writes = upstream.seen.filter((entry) => entry.method === "POST");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].body, writes[1].body);
  assert.equal(writes[0].body.request_id, "pause-1");
  assert.equal(writes[0].body.args.assignments[0].expected_revision, 9);

  const stale = await request(8, "tools/call", { name: "orchestration_enroll", _meta: metadata, arguments: { request_id: "stale-1", args: { expected_revision: 8 } } });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /stale_revision/);
  assert.doesNotMatch(stale.result.content[0].text, new RegExp(token));

  upstream.setRejectAuth(true);
  const unauthorized = await request(9, "tools/call", { name: "orchestration_state", arguments: {} });
  assert.equal(unauthorized.result.isError, true);
  assert.doesNotMatch(unauthorized.result.content[0].text, new RegExp(token));
});

test("Windows launcher closes its owned WSL child when MCP input reaches EOF", { skip: process.platform !== "win32" }, async (t) => {
  const child = spawn(process.execPath, [join(process.cwd(), "mcp/server.mjs")], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_ORCHESTRATION_CONFIG: "C:\\codex-orchestration-missing\\config.json" },
    stdio: ["pipe", "ignore", "pipe"]
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.end();
  const closed = await Promise.race([
    once(child, "close"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Windows launcher did not close its WSL child after stdin EOF")), 10_000))
  ]);
  assert.equal(Array.isArray(closed), true);
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

test("native MCP metadata binds one private PM credential per Codex thread", async (t) => {
  const token = "fixture-secret-token";
  const threadA = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d72";
  const threadB = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d73";
  const pmA = derivePmCredential(token, threadA);
  const pmB = derivePmCredential(token, threadB);
  const upstream = await startFixture(token, "127.0.0.1", [token, pmA, pmB]);
  const root = process.platform === "win32"
    ? `/tmp/codex-orchestration-identity-${process.pid}-${Date.now()}`
    : realpathSync.native(await mkdtemp(join(tmpdir(), "codex-orchestration-identity-")));
  const tokenFile = process.platform === "win32" ? `${root}/token` : join(root, "token");
  const configFile = process.platform === "win32" ? `${root}/config.json` : join(root, "config.json");
  const config = JSON.stringify({ host: "127.0.0.1", port: upstream.port, token_file: tokenFile });
  if (process.platform === "win32") {
    const wslNode = await resolveWslNode();
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
    env: { ...process.env, CODEX_ORCHESTRATION_CONFIG: configFile },
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
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const args = {
    request_id: "identity-1",
    args: {
      scope: "assignments",
      project_id: "project-1",
      assignments: [{ assignment_id: "assignment-1", expected_revision: 9, expected_ownership_revision: 0 }],
      owner: "spoofed-model-owner"
    }
  };
  const callA = await request(2, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadA, "x-codex-turn-metadata": { thread_id: threadA } }, arguments: args });
  assert.equal(callA.result.isError, undefined);
  const callB = await request(3, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadB, "x-codex-turn-metadata": { thread_id: threadB } }, arguments: { ...args, request_id: "identity-2" } });
  assert.equal(callB.result.isError, undefined);
  const writes = upstream.seen.filter((entry) => entry.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].authorization, `Bearer ${pmA}`);
  assert.equal(writes[1].authorization, `Bearer ${pmB}`);
  assert.notEqual(writes[0].authorization, writes[1].authorization);
  assert.equal(writes[0].body.args.owner, "spoofed-model-owner");

  const beforeMissing = writes.length;
  const missing = await request(4, "tools/call", { name: "orchestration_pause", arguments: args });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /caller_identity_required/);
  assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, beforeMissing);

  const mismatch = await request(5, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadA, "x-codex-turn-metadata": { thread_id: threadB } }, arguments: args });
  assert.equal(mismatch.result.isError, true);
  assert.match(mismatch.result.content[0].text, /caller_identity_mismatch/);
  assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, beforeMissing);
});

test("operator CLI sends a private control envelope once with the install credential", async (t) => {
  const token = "fixture-secret-token";
  const upstream = await startFixture(token);
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-control-"));
  const tokenFile = join(root, "token");
  const configFile = join(root, "config.json");
  const inputFile = join(root, "control.json");
  await writeFile(tokenFile, `${token}\n`);
  if (process.platform !== "win32") await chmod(tokenFile, 0o600);
  await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port: upstream.port, token_file: tokenFile }));
  await writeFile(inputFile, JSON.stringify({
    request_id: "operator-pause-1",
    operation: "pause",
    args: { scope: "service", reason: "fixture" }
  }));
  t.after(async () => {
    await closeFixture(upstream.fixture);
    await rm(root, { recursive: true, force: true });
  });

  const result = await runProcess(process.execPath, [join(process.cwd(), "dist/cli.js"), "control", "--input", inputFile], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_ORCHESTRATION_CONFIG: configFile }
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { accepted: true, request_id: "operator-pause-1" });
  assert.doesNotMatch(result.stdout, new RegExp(token));
  const writes = upstream.seen.filter((entry) => entry.method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].authorization, `Bearer ${token}`);
  assert.deepEqual(writes[0].body, {
    request_id: "operator-pause-1",
    operation: "pause",
    args: { scope: "service", reason: "fixture" }
  });

  await writeFile(inputFile, JSON.stringify({ request_id: "pm-1", operation: "enroll", args: {} }));
  const rejected = await runProcess(process.execPath, [join(process.cwd(), "dist/cli.js"), "control", "--input", inputFile], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_ORCHESTRATION_CONFIG: configFile }
  });
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /operator_required/);
  assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, 1);
});

test("MCP launcher reports a retired package entrypoint clearly", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-retired-package-"));
  const missing = join(root, "mcp", "server.mjs");
  try {
    assert.throws(() => assertMcpEntrypoint(missing), /entrypoint is missing from the installed plugin package/);
    await writeFile(join(root, "directory-entrypoint"), "placeholder");
    assert.throws(() => assertMcpEntrypoint(root), /entrypoint is not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
