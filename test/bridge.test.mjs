import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { ManagedClient, derivePmCredential } from "../dist/client.js";
import { validateConfig } from "../dist/config.js";
import { writeRequirementSession } from "../dist/requirements_session.js";

const execFile = promisify(execFileCallback);
const mcpHarness = join(process.cwd(), "test", "fixtures", "mcp-server-harness.mjs");
const cliHarness = join(process.cwd(), "test", "fixtures", "cli-harness.mjs");

function readJsonLines(child) {
  let buffer = ""; const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue; const message = JSON.parse(line); const handler = pending.get(message.id);
      if (handler) { pending.delete(message.id); handler(message); }
    }
  });
  return (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.delete(id)) reject(new Error("timed out waiting for MCP response")); }, 10_000).unref();
  });
}
async function fixture(token, accepted, host = "127.0.0.1") {
  const seen = []; let dropMutation = false; let mode = "normal"; let errorCode = "unauthorized"; let errorStatus = 401; let rejectAuth = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    seen.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });
    const credential = request.headers.authorization?.replace(/^Bearer /, "");
    if (rejectAuth || (!accepted.includes(request.headers.authorization) && !accepted.includes(credential))) { response.statusCode = errorStatus; response.end(JSON.stringify({ error: { code: errorCode, detail: token } })); return; }
    if (dropMutation && request.method === "POST") { request.socket.destroy(); return; }
    response.setHeader("content-type", "application/json");
    if (mode === "redirect") { response.statusCode = 302; response.setHeader("location", "/api/v1/managed/state"); response.end(); return; }
    if (mode === "overflow") { response.end("x".repeat(1_048_577)); return; }
    if (mode === "malformed") { response.end("{"); return; }
    if (mode === "truncated") { response.setHeader("content-length", "128"); response.write('{"accepted":true'); response.destroy(); return; }
    if (mode === "empty") { response.end(); return; }
    if (request.url?.startsWith("/api/v1/managed/state")) response.end(JSON.stringify({ revision: 4, latest_cursor: 2 }));
    else if (request.url?.startsWith("/api/v1/managed/events")) response.end(JSON.stringify({ events: [], latest_cursor: 2 }));
    else response.end(JSON.stringify({ accepted: true, request_id: body.request_id }));
  });
  server.listen(0, host); await Promise.race([once(server, "listening"), once(server, "error").then(([error]) => { throw error; })]);
  return { server, seen, port: server.address().port, setDrop: (value) => { dropMutation = value; }, setMode: (value) => { mode = value; }, setRejectAuth: (value) => { rejectAuth = value; }, setErrorCode: (value) => { errorCode = value; }, setErrorStatus: (value) => { errorStatus = value; } };
}
async function close(server) { if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
async function protectTokenFile(tokenFile) {
  if (process.platform !== "win32") { await chmod(tokenFile, 0o600); return; }
  const who = await execFile("whoami.exe", ["/user"], { windowsHide: true });
  const sid = who.stdout.match(/S-\d-\d+(?:-\d+)+/)?.[0]; assert.ok(sid, "current Windows SID must be available");
  await execFile("icacls.exe", [tokenFile, "/reset", "/c"], { windowsHide: true });
  await execFile("icacls.exe", [tokenFile, "/inheritance:r", "/grant:r", "*" + sid + ":F", "/c"], { windowsHide: true });
  await execFile("icacls.exe", [tokenFile, "/setowner", "*" + sid, "/c"], { windowsHide: true });
}
async function writeBridgeConfig(root, port, token) {
  const configRoot = join(root, "config"); const tokenFile = join(configRoot, "token"); const configFile = join(configRoot, "config.json");
  await mkdir(configRoot, { recursive: true }); await writeFile(tokenFile, token + "\n");
  await protectTokenFile(tokenFile);
  await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port, token_file: tokenFile }));
  return { configFile, tokenFile };
}
function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("native bridge registers all 16 tools before configuration or loopback contact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-native-"));
  const child = spawn(process.execPath, [mcpHarness, root], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); });
  const request = readJsonLines(child);
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const tools = await request(2, "tools/list");
  assert.equal(tools.result.tools.length, 16);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
    "orchestration_diagnostics", "orchestration_state", "orchestration_events",
    "orchestration_requirements_read", "orchestration_requirements_update", "orchestration_requirements_acknowledge",
    "orchestration_register_pm", "orchestration_claim", "orchestration_enroll", "orchestration_revise",
    "orchestration_pause", "orchestration_resume", "orchestration_interrupt", "orchestration_cancel",
    "orchestration_review", "orchestration_handoff"
  ]);
  const diagnostic = await request(3, "tools/call", { name: "orchestration_diagnostics", arguments: {} });
  assert.equal(diagnostic.result.isError, undefined);
  assert.match(diagnostic.result.content[0].text, /config_missing/);
});

test("native MCP requirements tools work without Symphony and fence untrusted or stale writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-mcp-"));
  const threadId = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d72";
  const child = spawn(process.execPath, [mcpHarness, root], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "close"); } await rm(root, { recursive: true, force: true }); });
  const request = readJsonLines(child);
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "requirements-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const initial = await request(2, "tools/call", { name: "orchestration_requirements_read", arguments: { cwd: root } });
  const initialState = JSON.parse(initial.result.content[0].text);
  assert.equal(initialState.exists, false);
  const content = [
    "# Requirements", "", "## No MFA for IHARC hosting",
    "- Scope: IHARC hosting", "- Source: Jordan, 2026-09-16",
    "- Decision: Do not enable or require MFA unless Jordan explicitly changes this direction.", ""
  ].join("\n");
  const untrusted = await request(3, "tools/call", { name: "orchestration_requirements_update", arguments: { cwd: root, expected_fingerprint: initialState.fingerprint, content } });
  assert.equal(untrusted.result.isError, true);
  assert.match(untrusted.result.content[0].text, /^caller_identity_required:/);
  const metadata = { threadId, "x-codex-turn-metadata": { thread_id: threadId } };
  const updated = await request(4, "tools/call", { name: "orchestration_requirements_update", _meta: metadata, arguments: { cwd: root, expected_fingerprint: initialState.fingerprint, content } });
  assert.equal(updated.result.isError, undefined);
  const updatedState = JSON.parse(updated.result.content[0].text);
  const stale = await request(5, "tools/call", { name: "orchestration_requirements_update", _meta: metadata, arguments: { cwd: root, expected_fingerprint: initialState.fingerprint, content } });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /^requirements_revision_conflict:/);
  await writeRequirementSession(threadId, { cwd: root, fingerprint: updatedState.fingerprint, pendingTurn: "turn-42" }, root);
  const acknowledgement = await request(6, "tools/call", { name: "orchestration_requirements_acknowledge", _meta: metadata, arguments: { cwd: root, turn_id: "turn-42", fingerprint: updatedState.fingerprint, outcome: "unchanged" } });
  assert.equal(acknowledgement.result.isError, undefined);
  assert.deepEqual(JSON.parse(acknowledgement.result.content[0].text), { acknowledged: true });
  // A user-authorized multi-repository task can explicitly capture a decision
  // in a second project; native identity and per-file CAS still apply.
  const secondProject = join(root, "second-project");
  await mkdir(secondProject);
  const secondRead = await request(7, "tools/call", { name: "orchestration_requirements_read", arguments: { cwd: secondProject } });
  const secondState = JSON.parse(secondRead.result.content[0].text);
  const secondUpdate = await request(8, "tools/call", { name: "orchestration_requirements_update", _meta: metadata, arguments: { cwd: secondProject, expected_fingerprint: secondState.fingerprint, content } });
  assert.equal(secondUpdate.result.isError, undefined);
  assert.equal(JSON.parse(secondUpdate.result.content[0].text).content, content);
});

test("native bridge preserves request id and fences with the trusted thread credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-wire-"));
  const threadId = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d72"; const token = "fixture-secret";
  const upstream = await fixture(token, ["Bearer " + derivePmCredential(token, threadId)]);
  await writeFile(join(root, "token"), token + "\n"); await protectTokenFile(join(root, "token"));
  await writeFile(join(root, "config.json"), JSON.stringify({ host: "127.0.0.1", port: upstream.port, token_file: join(root, "token") }));
  const client = new ManagedClient({ host: "127.0.0.1", port: upstream.port, tokenFile: join(root, "token"), maxInputBytes: 16 * 1024 }, token, threadId);
  t.after(async () => { await close(upstream.server); await rm(root, { recursive: true, force: true }); });
  const request = { request_id: "pause-7", operation: "pause", args: { scope: "assignments", project_id: "project-1", assignments: [{ assignment_id: "assignment-1", expected_revision: 4, expected_ownership_revision: 2 }] } };
  assert.deepEqual(await client.control(request), { accepted: true, request_id: "pause-7" });
  assert.deepEqual(upstream.seen[0].body, request);
  assert.equal(upstream.seen[0].authorization, "Bearer " + derivePmCredential(token, threadId));
  upstream.setDrop(true);
  await assert.rejects(() => client.control({ ...request, request_id: "pause-8" }), (error) => error.code === "mutation_outcome_uncertain");
  assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, 2);
});

test("client rejects redirects, bounds responses, and makes malformed mutation responses uncertain", async (t) => {
  const token = "fixture-secret"; const upstream = await fixture(token, [token]);
  const client = new ManagedClient({ host: "127.0.0.1", port: upstream.port, tokenFile: "unused", maxInputBytes: 16 * 1024 }, token);
  t.after(() => close(upstream.server));
  upstream.setMode("redirect");
  await assert.rejects(() => client.state(), (error) => error.code === "upstream_unreachable");
  upstream.setMode("overflow");
  await assert.rejects(() => client.state(), (error) => error.code === "upstream_response_too_large");
  await assert.rejects(() => client.control({ request_id: "oversized-1", operation: "pause", args: { scope: "service" } }), (error) => error.code === "mutation_outcome_uncertain");
  upstream.setMode("malformed");
  await assert.rejects(() => client.control({ request_id: "malformed-1", operation: "pause", args: { scope: "service" } }), (error) => error.code === "mutation_outcome_uncertain");
  upstream.setMode("truncated");
  await assert.rejects(() => client.control({ request_id: "truncated-1", operation: "pause", args: { scope: "service" } }), (error) => error.code === "mutation_outcome_uncertain");
  upstream.setMode("empty");
  await assert.rejects(() => client.control({ request_id: "empty-1", operation: "pause", args: { scope: "service" } }), (error) => error.code === "mutation_outcome_uncertain");
  upstream.setMode("normal"); upstream.setRejectAuth(true); upstream.setErrorCode(token); upstream.setErrorStatus(409);
  await assert.rejects(() => client.state(), (error) => error.code === "upstream_error" && error.message === "Symphony request failed with HTTP 409" && !error.message.includes(token));
});

test("client brackets an IPv6 loopback endpoint when used directly", async (t) => {
  const token = "fixture-secret"; let upstream;
  try { upstream = await fixture(token, [token], "::1"); } catch { t.skip("IPv6 loopback is unavailable on this host"); return; }
  t.after(() => close(upstream.server));
  const client = new ManagedClient({ host: "::1", port: upstream.port, tokenFile: "unused", maxInputBytes: 16 * 1024 }, token);
  assert.deepEqual(await client.state(), { revision: 4, latest_cursor: 2 });
});

test("native MCP calls bind _meta thread identity and do not trust spoofed task fields", async (t) => {
  const token = "fixture-secret"; const threadA = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d72"; const threadB = "018f4b48-8e5a-7f55-a2e8-0c1f5f9e6d73";
  const upstream = await fixture(token, [derivePmCredential(token, threadA), derivePmCredential(token, threadB)]);
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-identity-")); const { configFile } = await writeBridgeConfig(root, upstream.port, token);
  const child = spawn(process.execPath, [mcpHarness, root], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "close"); } await close(upstream.server); await rm(root, { recursive: true, force: true }); });
  const request = readJsonLines(child);
  await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "metadata-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const args = { request_id: "identity-1", args: { scope: "assignments", project_id: "project-1", assignments: [{ assignment_id: "assignment-1", expected_revision: 4, expected_ownership_revision: 2 }], owner: "spoofed-model-owner" } };
  const callA = await request(2, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadA, "x-codex-turn-metadata": { thread_id: threadA } }, arguments: args });
  const callB = await request(3, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadB, "x-codex-turn-metadata": { thread_id: threadB } }, arguments: { ...args, request_id: "identity-2" } });
  assert.equal(callA.result.isError, undefined); assert.equal(callB.result.isError, undefined);
  const writes = upstream.seen.filter((entry) => entry.method === "POST"); assert.equal(writes.length, 2); assert.equal(writes[0].authorization, "Bearer " + derivePmCredential(token, threadA)); assert.equal(writes[1].authorization, "Bearer " + derivePmCredential(token, threadB)); assert.equal(writes[0].body.args.owner, "spoofed-model-owner");
  const missing = await request(4, "tools/call", { name: "orchestration_pause", arguments: args }); assert.equal(missing.result.isError, true); assert.match(missing.result.content[0].text, /caller_identity_required/); assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, 2);
  const mismatch = await request(5, "tools/call", { name: "orchestration_pause", _meta: { threadId: threadA, "x-codex-turn-metadata": { thread_id: threadB } }, arguments: args }); assert.equal(mismatch.result.isError, true); assert.match(mismatch.result.content[0].text, /caller_identity_mismatch/); assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, 2);
  assert.ok(configFile.endsWith("config.json"));
});

test("operator CLI sends one private control envelope with the install credential", async (t) => {
  const token = "fixture-secret"; const upstream = await fixture(token, [token]); const root = await mkdtemp(join(tmpdir(), "codex-orchestration-control-")); const { configFile } = await writeBridgeConfig(root, upstream.port, token); const inputFile = join(root, "control.json");
  await writeFile(inputFile, JSON.stringify({ request_id: "operator-pause-1", operation: "pause", args: { scope: "service", reason: "fixture" } }));
  t.after(async () => { await close(upstream.server); await rm(root, { recursive: true, force: true }); });
  const result = await runProcess(process.execPath, [cliHarness, root, "control", "--input", inputFile], { cwd: process.cwd(), env: process.env });
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { accepted: true, request_id: "operator-pause-1" }); assert.doesNotMatch(result.stdout, new RegExp(token));
  const writes = upstream.seen.filter((entry) => entry.method === "POST"); assert.equal(writes.length, 1); assert.equal(writes[0].authorization, "Bearer " + token); assert.deepEqual(writes[0].body, { request_id: "operator-pause-1", operation: "pause", args: { scope: "service", reason: "fixture" } }); assert.ok(configFile.endsWith("config.json"));
  await writeFile(inputFile, JSON.stringify({ request_id: "pm-1", operation: "enroll", args: {} }));
  const rejected = await runProcess(process.execPath, [cliHarness, root, "control", "--input", inputFile], { cwd: process.cwd(), env: process.env });
  assert.equal(rejected.code, 1); assert.match(rejected.stderr, /operator_required/); assert.equal(upstream.seen.filter((entry) => entry.method === "POST").length, 1);
});

test("configuration rejects non-loopback hosts and token paths outside the private root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-config-"));
  await mkdir(join(root, "config"), { recursive: true }); const tokenFile = join(root, "config", "token"); const configFile = join(root, "config", "config.json");
  await writeFile(tokenFile, "secret\n"); await protectTokenFile(tokenFile);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(configFile, JSON.stringify({ host: "10.0.0.1", port: 1234, token_file: tokenFile })); assert.equal((await validateConfig(root)).valid, false); assert.match((await validateConfig(root)).error, /config_non_loopback/);
  await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port: 1234, token_file: join(tmpdir(), "outside-token") })); assert.equal((await validateConfig(root)).valid, false); assert.match((await validateConfig(root)).error, /config_token_outside_root/);
});

test("configuration rejects an explicit Windows Users ACE on the token", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-acl-"));
  const { tokenFile } = await writeBridgeConfig(root, 1234, "secret");
  await execFile("icacls.exe", [tokenFile, "/grant", "*S-1-5-32-545:R", "/c"], { windowsHide: true });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const diagnostic = await validateConfig(root);
  assert.equal(diagnostic.valid, false); assert.match(diagnostic.error, /config_token_permissions/);
});
