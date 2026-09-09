import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { CheckoutError, prepareTrustedCheckout } from "../dist/checkout.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 1_048_576, windowsHide: true });
  return result.stdout.trim();
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("trusted checkout consumes issue context, enforces enrollment, and pins the base commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-checkout-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const workspaceRoot = join(root, "workspaces");
  const workspace = join(workspaceRoot, "fixture-alpha");
  const input = join(root, "attempt.json");
  const policy = join(root, "checkout-policy.json");
  const previousContext = process.env.SYMPHONY_ISSUE_CONTEXT;
  const previousPolicy = process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY;
  t.after(async () => {
    if (previousContext === undefined) delete process.env.SYMPHONY_ISSUE_CONTEXT;
    else process.env.SYMPHONY_ISSUE_CONTEXT = previousContext;
    if (previousPolicy === undefined) delete process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY;
    else process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY = previousPolicy;
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(workspaceRoot);
  await git(root, "init", source);
  await git(source, "config", "user.email", "fixture@example.invalid");
  await git(source, "config", "user.name", "Fixture");
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "fixture");
  const commit = await git(source, "rev-parse", "HEAD");
  await git(root, "clone", "--bare", source, remote);

  await writeJson(policy, {
    control_root: root,
    workspace_root: workspaceRoot,
    repositories: { "fixture/alpha": { remote: pathToFileURL(remote).href } }
  });
  await writeJson(input, { assignment_id: "project-item-1", attempt_id: "attempt-1", repository: "fixture/alpha", base_commit: commit, workspace });
  process.env.SYMPHONY_ISSUE_CONTEXT = JSON.stringify({
    id: "project-item-1",
    identifier: "fixture/alpha#1",
    native_ref: { repository: { name_with_owner: "fixture/alpha" } }
  });
  process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY = policy;

  const result = await prepareTrustedCheckout({ inputFile: input });
  assert.deepEqual(result, {
    issue_id: "project-item-1",
    identifier: "fixture/alpha#1",
    assignment_id: "project-item-1",
    attempt_id: "attempt-1",
    repository: "fixture/alpha",
    base_commit: commit,
    workspace: join(await realpath(workspaceRoot), "fixture-alpha")
  });
  assert.equal(await git(workspace, "rev-parse", "HEAD"), commit);
  const cli = await execFileAsync(process.execPath, [join(process.cwd(), "dist/cli.js"), "checkout", "--input", input, "--policy", policy], {
    env: { ...process.env, SYMPHONY_ISSUE_CONTEXT: process.env.SYMPHONY_ISSUE_CONTEXT }
  });
  assert.deepEqual(JSON.parse(cli.stdout), result);

  await git(workspace, "switch", "-c", "worker/attempt-1");
  await writeFile(join(workspace, "worker.txt"), "preserve me\n");
  await git(workspace, "add", "worker.txt");
  await git(workspace, "commit", "-m", "worker change");
  const workerHead = await git(workspace, "rev-parse", "HEAD");
  const resumed = await prepareTrustedCheckout({ inputFile: input });
  assert.equal(await git(workspace, "rev-parse", "HEAD"), workerHead);
  assert.equal(await git(workspace, "branch", "--show-current"), "worker/attempt-1");
  assert.equal(resumed.workspace, result.workspace);

  await writeFile(join(workspace, "unaccepted.txt"), "keep me\n");
  const resumedDirty = await prepareTrustedCheckout({ inputFile: input });
  assert.equal(resumedDirty.workspace, result.workspace);
  assert.equal(await readFile(join(workspace, "unaccepted.txt"), "utf8"), "keep me\n");
});

test("trusted checkout rejects context, policy, and workspace boundary mismatches before Git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-checkout-reject-"));
  const input = join(root, "attempt.json");
  const policy = join(root, "checkout-policy.json");
  const previousContext = process.env.SYMPHONY_ISSUE_CONTEXT;
  const previousPolicy = process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY;
  t.after(async () => {
    if (previousContext === undefined) delete process.env.SYMPHONY_ISSUE_CONTEXT;
    else process.env.SYMPHONY_ISSUE_CONTEXT = previousContext;
    if (previousPolicy === undefined) delete process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY;
    else process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY = previousPolicy;
    await rm(root, { recursive: true, force: true });
  });

  await writeJson(policy, {
    control_root: root,
    workspace_root: root,
    repositories: { "fixture/alpha": { remote: "https://github.com/fixture/alpha.git" } }
  });
  await writeJson(input, {
    assignment_id: "project-item-2",
    attempt_id: "attempt-2",
    repository: "fixture/alpha",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    workspace: join(root, "..", "outside")
  });
  process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY = policy;
  process.env.SYMPHONY_ISSUE_CONTEXT = JSON.stringify({
    id: "project-item-2",
    identifier: "fixture/beta#2",
    native_ref: { repository: { name_with_owner: "fixture/beta" } }
  });
  await assert.rejects(() => prepareTrustedCheckout({ inputFile: input }), (error) => error instanceof CheckoutError && error.code === "repository_mismatch");

  process.env.SYMPHONY_ISSUE_CONTEXT = JSON.stringify({
    id: "project-item-2",
    identifier: "fixture/alpha#2",
    native_ref: { repository: { name_with_owner: "fixture/alpha" } }
  });
  await assert.rejects(() => prepareTrustedCheckout({ inputFile: input }), (error) => error instanceof CheckoutError && error.code === "workspace_outside_root");

  process.env.SYMPHONY_ISSUE_CONTEXT = "{}";
  await assert.rejects(() => prepareTrustedCheckout({ inputFile: input }), (error) => error instanceof CheckoutError && error.code === "context_invalid");
  delete process.env.SYMPHONY_ISSUE_CONTEXT;
  await assert.rejects(() => prepareTrustedCheckout({ inputFile: input }), (error) => error instanceof CheckoutError && error.code === "context_missing");
});

