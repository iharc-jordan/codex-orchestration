import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { readRequirements, updateRequirements } from "../dist/requirements.js";

const execFile = promisify(execFileCallback);

const initial = [
  "# Requirements",
  "",
  "## No MFA for IHARC hosting",
  "- Scope: IHARC hosting customer and administrator workflows",
  "- Source: Jordan, 2026-09-16",
  "- Decision: Do not enable or require MFA unless Jordan explicitly changes this direction.",
  ""
].join("\n");

test("requirements start absent and use the empty fingerprint for first compare-and-set update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readRequirements(root, { testRoot: root });
  assert.equal(before.exists, false);
  assert.equal(before.content, "");
  assert.match(before.fingerprint, /^sha256:[a-f0-9]{64}$/);
  const after = await updateRequirements(root, { expected_fingerprint: before.fingerprint, content: initial }, { testRoot: root });
  assert.equal(after.exists, true);
  assert.equal(after.path, join(root, "REQUIREMENTS.md"));
  assert.equal(after.content, initial);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(await readFile(after.path, "utf8"), initial);
});

test("requirements reject stale writes and entries without explicit user source metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readRequirements(root, { testRoot: root });
  const saved = await updateRequirements(root, { expected_fingerprint: before.fingerprint, content: initial }, { testRoot: root });
  await assert.rejects(
    () => updateRequirements(root, { expected_fingerprint: before.fingerprint, content: initial.replace("No MFA", "Changed") }, { testRoot: root }),
    (error) => error.code === "requirements_revision_conflict"
  );
  const untrusted = initial.replace("Source: Jordan", "Source: assistant");
  await assert.rejects(
    () => updateRequirements(root, { expected_fingerprint: saved.fingerprint, content: untrusted }, { testRoot: root }),
    (error) => error.code === "requirements_content_invalid"
  );
});

test("an explicit empty requirements registry is a valid supersession state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialState = await readRequirements(root, { testRoot: root });
  const saved = await updateRequirements(root, { expected_fingerprint: initialState.fingerprint, content: initial }, { testRoot: root });
  const empty = "# Requirements\n";
  const cleared = await updateRequirements(root, { expected_fingerprint: saved.fingerprint, content: empty }, { testRoot: root });
  assert.equal(cleared.content, empty);
  assert.equal(cleared.exists, true);
});

test("private root mapping resolves a different repository to one canonical requirement file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  const canonical = join(root, "canonical");
  const other = join(root, "other");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(canonical, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(canonical, "REQUIREMENTS.md"), initial);
  await writeFile(join(root, "config", "requirements.json"), JSON.stringify({ version: 1, roots: { [other]: canonical } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readRequirements(other, { testRoot: root });
  assert.equal(before.canonicalRoot, canonical);
  const after = await updateRequirements(other, { expected_fingerprint: before.fingerprint, content: initial.replace("No MFA", "No hosting MFA") }, { testRoot: root });
  assert.equal(after.path, join(canonical, "REQUIREMENTS.md"));
  assert.equal((await readRequirements(canonical, { testRoot: root })).fingerprint, after.fingerprint);
});

test("configured cross-repository mapping fails visibly when its canonical file is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  const canonical = join(root, "canonical");
  const other = join(root, "other");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(canonical, { recursive: true });
  await mkdir(other, { recursive: true });
  await writeFile(join(root, "config", "requirements.json"), JSON.stringify({ version: 1, roots: { [other]: canonical } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => readRequirements(other, { testRoot: root }), (error) => error.code === "requirements_file_missing");
});

test("private remote mapping overrides a managed clone's stale requirements for HTTPS and SSH origins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-clone-"));
  const clone = join(root, "managed-clone");
  const canonical = join(root, "canonical");
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(clone, { recursive: true });
  await mkdir(canonical, { recursive: true });
  await execFile("git", ["init", clone], { windowsHide: true });
  await writeFile(join(clone, "REQUIREMENTS.md"), "# Requirements\n\n## Stale clone copy\n- Scope: clone\n- Source: User\n- Decision: stale\n");
  await writeFile(join(canonical, "REQUIREMENTS.md"), initial);
  await writeFile(join(root, "config", "requirements.json"), JSON.stringify({
    version: 1,
    roots: {},
    repositories: { "github.com/iharc/iharc-labs-hosting": canonical }
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile("git", ["-C", clone, "remote", "add", "origin", "https://github.com/IHARC/iharc-labs-hosting.git"], { windowsHide: true });
  const https = await readRequirements(clone, { testRoot: root });
  assert.equal(https.content, initial);
  await execFile("git", ["-C", clone, "remote", "set-url", "origin", "git@github.com:IHARC/iharc-labs-hosting.git"], { windowsHide: true });
  const ssh = await readRequirements(clone, { testRoot: root });
  assert.equal(ssh.content, initial);
});

test("Git subdirectories and linked worktrees resolve to the primary checkout requirements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-git-"));
  const subdirectory = join(root, "nested", "work");
  const linked = join(tmpdir(), `codex-orchestration-requirements-linked-${process.pid}-${Date.now()}`);
  await mkdir(subdirectory, { recursive: true });
  t.after(async () => { await rm(linked, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  await execFile("git", ["init", root], { windowsHide: true });
  await execFile("git", ["-C", root, "config", "user.email", "requirements-test@example.invalid"], { windowsHide: true });
  await execFile("git", ["-C", root, "config", "user.name", "Requirements Test"], { windowsHide: true });
  await writeFile(join(root, "seed.txt"), "seed\n");
  await execFile("git", ["-C", root, "add", "seed.txt"], { windowsHide: true });
  await execFile("git", ["-C", root, "commit", "-m", "seed"], { windowsHide: true });
  await execFile("git", ["-C", root, "worktree", "add", "-b", "requirements-test-worktree", linked], { windowsHide: true });
  await writeFile(join(root, "REQUIREMENTS.md"), initial);
  const fromSubdirectory = await readRequirements(subdirectory, { testRoot: root });
  const fromWorktree = await readRequirements(linked, { testRoot: root });
  assert.equal(fromSubdirectory.content, initial);
  assert.equal(fromWorktree.content, initial);
  assert.equal(await readFile(fromSubdirectory.path, "utf8"), initial);
  assert.equal(await readFile(fromWorktree.path, "utf8"), initial);
  const gitPointer = join(linked, ".git");
  const originalPointer = join(linked, ".git.requirements-test-backup");
  await rename(gitPointer, originalPointer);
  try {
    await writeFile(gitPointer, "gitdir: missing-worktree-directory\n");
    await assert.rejects(
      () => readRequirements(linked, { testRoot: root }),
      (error) => error.code === "requirements_repository_unreadable"
    );
  } finally {
    await rm(gitPointer, { force: true });
    await rename(originalPointer, gitPointer);
  }
});

test("invalid mappings fail visibly instead of treating them as empty requirements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-orchestration-requirements-"));
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "requirements.json"), "{bad");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => readRequirements(root, { testRoot: root }), (error) => error.code === "requirements_mapping_unreadable");
});
