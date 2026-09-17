import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { orchestrationPaths } from "./paths.js";

const execFile = promisify(execFileCallback);
const REQUIREMENTS_FILE = "REQUIREMENTS.md";
const MAX_REQUIREMENTS_BYTES = 128 * 1024;

export interface RequirementsState {
  path: string;
  fingerprint: string;
  content: string;
  exists: boolean;
  canonicalRoot: string;
}

export class RequirementsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RequirementsError";
  }
}

type RequirementsMapping = { version: 1; roots: Record<string, string>; repositories: Record<string, string> };

function fingerprint(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root: string, candidate: string): boolean {
  const outside = relative(root, candidate);
  return outside === "" || (!isAbsolute(outside) && outside !== ".." && !outside.startsWith(`..${sep}`));
}

async function projectRoots(cwd: string): Promise<string[]> {
  const requested = resolve(cwd);
  try {
    if (!(await stat(requested)).isDirectory()) {
      throw new RequirementsError("requirements_cwd_invalid", "cwd must identify a directory");
    }
  } catch (error) {
    if (error instanceof RequirementsError) throw error;
    throw new RequirementsError("requirements_cwd_unreadable", "cwd could not be inspected; check filesystem availability and permissions");
  }
  try {
    const result = await execFile("git", ["-C", requested, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 2) throw new Error("unexpected git output");
    const repositoryRoot = resolve(lines[0]);
    const commonDirectory = resolve(lines[1]);
    const roots = [repositoryRoot];
    if (commonDirectory.endsWith(`${sep}.git`)) roots.push(dirname(commonDirectory));
    return roots.filter((root, index) => roots.findIndex((other) => samePath(root, other)) === index);
  } catch (error) {
    const details = error as Error & { code?: string | number; stderr?: string | Buffer };
    if (details.code === "ENOENT") {
      throw new RequirementsError("requirements_git_unavailable", "Git is required to resolve project requirements but is unavailable");
    }
    const stderr = String(details.stderr ?? "");
    if (/not a git repository/i.test(stderr) && !(await hasGitMetadata(requested))) {
      return [requested];
    }
    throw new RequirementsError("requirements_repository_unreadable", "Git could not resolve this project; check repository and worktree availability before continuing");
  }
}

async function hasGitMetadata(start: string): Promise<boolean> {
  let current = start;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RequirementsError("requirements_repository_unreadable", "Git metadata could not be inspected; check filesystem availability and permissions");
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function loadMapping(testRoot?: string): Promise<RequirementsMapping> {
  const path = orchestrationPaths(process.env, testRoot).requirementsConfig;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, roots: {}, repositories: {} };
    throw new RequirementsError("requirements_mapping_unreadable", "Requirements mapping could not be read; check filesystem availability and permissions");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RequirementsError("requirements_mapping_invalid", "Requirements mapping must be a JSON object");
  }
  const candidate = parsed as { version?: unknown; roots?: unknown; repositories?: unknown };
  if (candidate.version !== 1 || !candidate.roots || typeof candidate.roots !== "object" || Array.isArray(candidate.roots) ||
      (candidate.repositories !== undefined && (typeof candidate.repositories !== "object" || candidate.repositories === null || Array.isArray(candidate.repositories)))) {
    throw new RequirementsError("requirements_mapping_invalid", "Requirements mapping must contain version 1 and a roots object");
  }
  const roots: Record<string, string> = {};
  for (const [source, destination] of Object.entries(candidate.roots)) {
    if (!isAbsolute(source) || typeof destination !== "string" || !destination.trim() || !isAbsolute(destination)) {
      throw new RequirementsError("requirements_mapping_invalid", "Requirements mapping roots must use absolute source and canonical paths");
    }
    roots[resolve(source)] = resolve(destination);
  }
  const repositories: Record<string, string> = {};
  for (const [identity, destination] of Object.entries((candidate.repositories ?? {}) as Record<string, unknown>)) {
    const normalized = normalizeRepositoryIdentity(identity);
    if (!normalized || normalized !== identity || typeof destination !== "string" || !destination.trim() || !isAbsolute(destination)) {
      throw new RequirementsError("requirements_mapping_invalid", "Requirements repository mappings must use normalized host/owner/repository keys and absolute canonical paths");
    }
    repositories[normalized] = resolve(destination);
  }
  return { version: 1, roots, repositories };
}

async function canonicalRoot(cwd: string, testRoot?: string): Promise<{ root: string; mapped: boolean }> {
  if (typeof cwd !== "string" || !cwd.trim()) throw new RequirementsError("requirements_cwd_invalid", "cwd must be a non-empty path");
  const roots = await projectRoots(cwd);
  const mapping = await loadMapping(testRoot);
  for (const root of roots) {
    for (const [source, destination] of Object.entries(mapping.roots)) {
      if (samePath(root, source)) return { root: destination, mapped: true };
    }
  }
  const identity = await repositoryIdentity(roots[0]);
  if (identity && mapping.repositories[identity]) return { root: mapping.repositories[identity], mapped: true };
  return { root: roots.at(-1)!, mapped: false };
}

/** Normalize only configured Git hosting identities, never a user-controlled path. */
function normalizeRepositoryIdentity(value: string): string | undefined {
  const text = value.trim();
  const plain = /^([a-z0-9.-]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i.exec(text);
  if (plain && !plain[3].toLowerCase().endsWith(".git")) return `${plain[1].toLowerCase()}/${plain[2].toLowerCase()}/${plain[3].toLowerCase()}`;
  const ssh = /^git@([a-z0-9.-]+):([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(text);
  if (ssh) return `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}/${ssh[3].toLowerCase()}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return undefined;
    const pieces = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (pieces.length !== 2 || !/^[a-z0-9_.-]+$/i.test(pieces[0]) || !/^[a-z0-9_.-]+(?:\.git)?$/i.test(pieces[1])) return undefined;
    return `${url.hostname.toLowerCase()}/${pieces[0].toLowerCase()}/${pieces[1].replace(/\.git$/i, "").toLowerCase()}`;
  } catch {
    return undefined;
  }
}

async function repositoryIdentity(repositoryRoot: string): Promise<string | undefined> {
  try {
    const result = await execFile("git", ["-C", repositoryRoot, "config", "--get", "remote.origin.url"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" }
    });
    return normalizeRepositoryIdentity(result.stdout.trim());
  } catch (error) {
    const details = error as Error & { code?: string | number; stderr?: string | Buffer };
    // Exit 1 is Git's documented result for an unset configuration key. An
    // unknown remote is intentionally not a mapping error and uses normal root resolution.
    if (details.code === 1) return undefined;
    throw new RequirementsError("requirements_repository_unreadable", "Git remote identity could not be resolved; check repository availability and permissions");
  }
}

async function readRequirementFile(path: string, required: boolean): Promise<{ content: string; exists: boolean }> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new RequirementsError("requirements_file_invalid", "REQUIREMENTS.md must be a regular non-symlink file");
    }
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_REQUIREMENTS_BYTES) {
      throw new RequirementsError("requirements_file_too_large", "REQUIREMENTS.md exceeds the 128 KiB limit");
    }
    return { content, exists: true };
  } catch (error) {
    if (error instanceof RequirementsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (required) throw new RequirementsError("requirements_file_missing", "Configured canonical REQUIREMENTS.md is missing; restore or initialize the mapped project requirements");
      return { content: "", exists: false };
    }
    throw new RequirementsError("requirements_file_unreadable", "REQUIREMENTS.md could not be read; check filesystem availability and permissions");
  }
}

/** Resolve a repository or linked worktree to its canonical requirements file. */
export async function readRequirements(cwd: string, options: { testRoot?: string } = {}): Promise<RequirementsState> {
  const canonical = await canonicalRoot(cwd, options.testRoot);
  const path = join(canonical.root, REQUIREMENTS_FILE);
  const current = await readRequirementFile(path, canonical.mapped);
  return { path, canonicalRoot: canonical.root, content: current.content, exists: current.exists, fingerprint: fingerprint(current.content) };
}

function validateRequirements(content: string): void {
  if (typeof content !== "string" || !content.trim()) {
    throw new RequirementsError("requirements_content_invalid", "REQUIREMENTS.md must not be empty");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_REQUIREMENTS_BYTES) {
    throw new RequirementsError("requirements_content_too_large", "REQUIREMENTS.md exceeds the 128 KiB limit");
  }
  if (!/^# Requirements\s*$/m.test(content)) {
    throw new RequirementsError("requirements_content_invalid", "REQUIREMENTS.md must start with a # Requirements heading");
  }
  // An empty registry is how an explicit user supersession removes the last
  // current requirement. It remains a valid, visible requirements document.
  const entries = content.split(/^##\s+/m).slice(1);
  for (const entry of entries) {
    const heading = entry.split(/\r?\n/, 1)[0]?.trim();
    if (!heading) {
      throw new RequirementsError("requirements_content_invalid", "Each requirement entry needs a non-empty heading");
    }
    for (const field of ["Scope", "Source", "Decision"]) {
      if (!new RegExp(`^[-*]\\s*${field}:\\s*\\S.+$`, "mi").test(entry)) {
        throw new RequirementsError("requirements_content_invalid", `Each requirement entry must include ${field}:`);
      }
    }
    if (!/^[-*]\s*Source:\s*(Jordan|User)\b/im.test(entry)) {
      throw new RequirementsError("requirements_content_invalid", "Each requirement entry Source must identify Jordan or User");
    }
  }
}

/** Atomically replace requirements after verifying the caller's current fingerprint. */
export async function updateRequirements(
  cwd: string,
  input: { expected_fingerprint: string; content: string },
  options: { testRoot?: string } = {}
): Promise<RequirementsState> {
  if (!input || typeof input.expected_fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(input.expected_fingerprint)) {
    throw new RequirementsError("requirements_fingerprint_invalid", "expected_fingerprint must be a sha256 fingerprint returned by requirements_read");
  }
  validateRequirements(input.content);
  const resolved = await readRequirements(cwd, options);
  if (!inside(resolved.canonicalRoot, resolved.path)) {
    throw new RequirementsError("requirements_path_invalid", "Resolved REQUIREMENTS.md must remain inside the canonical root");
  }
  const lockPath = `${resolved.path}.lock`;
  try {
    await mkdir(dirname(resolved.path), { recursive: true });
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new RequirementsError("requirements_update_in_progress", "REQUIREMENTS.md is being updated; read it again and retry with the current fingerprint");
      }
      throw error;
    }
    try {
      // Re-read after acquiring the lock: the expected fingerprint is a real
      // compare-and-set fence rather than a best-effort precondition.
      const current = await readRequirements(cwd, options);
      if (current.path !== resolved.path || current.fingerprint !== input.expected_fingerprint) {
        throw new RequirementsError("requirements_revision_conflict", "REQUIREMENTS.md changed; read its current fingerprint before updating it");
      }
      const temporary = join(dirname(resolved.path), `.${REQUIREMENTS_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, input.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, resolved.path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    } finally {
      await rmdir(lockPath).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof RequirementsError) throw error;
    throw new RequirementsError("requirements_write_failed", "REQUIREMENTS.md could not be updated atomically; check filesystem availability and permissions");
  }
  return readRequirements(cwd, options);
}
