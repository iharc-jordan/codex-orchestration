import { execFile as nodeExecFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);
const CONTEXT_MAX_BYTES = 16 * 1024;
const INPUT_MAX_BYTES = 64 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/i;
const ATTEMPT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface IssueContext {
  id: string;
  identifier: string;
  native_ref: unknown;
}

export interface CheckoutInput {
  assignment_id: string;
  attempt_id: string;
  repository?: string;
  base_commit: string;
  workspace: string;
}

export interface CheckoutRepository {
  remote: string;
}

export interface CheckoutPolicy {
  workspace_root: string;
  control_root: string;
  repositories: Record<string, CheckoutRepository>;
}

export interface CheckoutOptions {
  inputFile: string;
  policyFile?: string;
  context?: string;
}

export interface TrustedCheckoutResult {
  issue_id: string;
  identifier: string;
  assignment_id: string;
  attempt_id: string;
  repository: string;
  base_commit: string;
  workspace: string;
}

export class CheckoutError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CheckoutError";
    this.code = code;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, message: string): never {
  throw new CheckoutError(code, message);
}

function repositoryName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!plainObject(value)) return undefined;
  for (const key of ["name_with_owner", "nameWithOwner", "full_name", "fullName"]) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function contextRepository(context: IssueContext): string {
  if (!plainObject(context.native_ref)) invalid("context_repository_missing", "issue context does not include a repository reference");
  const nativeRef = context.native_ref;
  const repository = repositoryName(nativeRef.repository) ?? repositoryName(nativeRef);
  if (!repository || !REPOSITORY_PATTERN.test(repository)) invalid("context_repository_invalid", "issue context repository reference is invalid");
  return repository;
}

function parseContext(raw: string): IssueContext {
  if (Buffer.byteLength(raw, "utf8") > CONTEXT_MAX_BYTES) invalid("context_too_large", "issue context exceeds 16384 bytes");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid("context_invalid", "issue context is not valid JSON");
  }
  if (!plainObject(value) || typeof value.id !== "string" || value.id.trim() === "" || typeof value.identifier !== "string" || value.identifier.trim() === "") {
    invalid("context_invalid", "issue context must include id and identifier");
  }
  return { id: value.id, identifier: value.identifier, native_ref: value.native_ref };
}

export function readIssueContext(raw = process.env.SYMPHONY_ISSUE_CONTEXT): IssueContext {
  if (!raw?.trim()) invalid("context_missing", "SYMPHONY_ISSUE_CONTEXT is required");
  return parseContext(raw);
}

async function readJsonFile(path: string, maxBytes: number, code: string): Promise<unknown> {
  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch {
    invalid(`${code}_unreadable`, "checkout input could not be read");
  }
  if (contents.byteLength > maxBytes) invalid(`${code}_too_large`, "checkout input exceeds its size limit");
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch {
    invalid(`${code}_invalid`, "checkout input is not valid JSON");
  }
}

function parseInput(value: unknown): CheckoutInput {
  if (!plainObject(value) || typeof value.assignment_id !== "string" || value.assignment_id.trim() === "" || typeof value.attempt_id !== "string" || value.attempt_id.trim() === "" || typeof value.base_commit !== "string" || typeof value.workspace !== "string") {
    invalid("input_invalid", "checkout input must include assignment_id, attempt_id, base_commit, and workspace");
  }
  if (value.repository !== undefined && typeof value.repository !== "string") invalid("input_invalid", "checkout repository must be a string");
  if (!ATTEMPT_PATTERN.test(value.attempt_id)) invalid("input_invalid", "checkout attempt_id is invalid");
  return {
    assignment_id: value.assignment_id,
    attempt_id: value.attempt_id,
    repository: value.repository as string | undefined,
    base_commit: value.base_commit,
    workspace: value.workspace
  };
}

function parseRemote(value: unknown): CheckoutRepository {
  if (!plainObject(value) || typeof value.remote !== "string" || value.remote.trim() === "") invalid("policy_invalid", "repository policy must provide a remote");
  const remote = value.remote.trim();
  if (/\s|[\u0000-\u001f]/.test(remote)) invalid("policy_invalid", "repository policy remote is invalid");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      if (!["https:", "ssh:", "file:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid("policy_invalid", "repository policy remote is invalid");
    } catch {
      invalid("policy_invalid", "repository policy remote is invalid");
    }
  } else if (!/^git@[A-Za-z0-9._-]+:[^\s]+$/.test(remote)) {
    invalid("policy_invalid", "repository policy remote is invalid");
  }
  return { remote };
}

function parsePolicy(value: unknown): CheckoutPolicy {
  if (!plainObject(value) || typeof value.workspace_root !== "string" || !isAbsolute(value.workspace_root) || typeof value.control_root !== "string" || !isAbsolute(value.control_root) || !plainObject(value.repositories)) {
    invalid("policy_invalid", "checkout policy must include absolute control_root, workspace_root, and repositories");
  }
  const repositories: Record<string, CheckoutRepository> = {};
  for (const [name, repository] of Object.entries(value.repositories)) {
    if (!REPOSITORY_PATTERN.test(name)) invalid("policy_invalid", "checkout policy contains an invalid repository name");
    repositories[name.toLowerCase()] = parseRemote(repository);
  }
  if (Object.keys(repositories).length === 0) invalid("policy_invalid", "checkout policy must allow at least one repository");
  return { control_root: value.control_root, workspace_root: value.workspace_root, repositories };
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function resolveWorkspace(rootInput: string, workspaceInput: string): Promise<{ root: string; workspace: string; exists: boolean }> {
  if (!isAbsolute(workspaceInput) || workspaceInput.includes("\0")) invalid("workspace_invalid", "workspace must be an absolute path");
  let root: string;
  try {
    root = await realpath(rootInput);
  } catch {
    invalid("workspace_root_invalid", "checkout workspace_root does not exist");
  }
  const rawWorkspace = resolve(workspaceInput);
  let workspace: string;
  let exists: boolean;
  try {
    const details = await lstat(rawWorkspace);
    if (details.isSymbolicLink()) invalid("workspace_invalid", "workspace must not be a symbolic link");
    if (!details.isDirectory()) invalid("workspace_invalid", "workspace must be a directory");
    workspace = await realpath(rawWorkspace);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let parent: string;
    try {
      parent = await realpath(dirname(rawWorkspace));
    } catch {
      invalid("workspace_invalid", "workspace parent does not exist");
    }
    workspace = resolve(parent, basename(rawWorkspace));
    exists = false;
  }
  if (!inside(root, workspace)) invalid("workspace_outside_root", "workspace is outside the trusted workspace_root");
  if (!exists) {
    const parent = dirname(workspace);
    if (!inside(root, parent) && parent !== root) invalid("workspace_outside_root", "workspace parent is outside the trusted workspace_root");
  }
  return { root, workspace, exists };
}

async function gitResult(args: string[], cwd?: string): Promise<{ code: number; stdout: string }> {
  try {
    const result = await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 1_048_576, windowsHide: true });
    return { code: 0, stdout: result.stdout.trim() };
  } catch {
    return { code: 1, stdout: "" };
  }
}

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await gitResult(args, cwd);
  if (result.code !== 0) invalid("git_failed", `git ${args[0] || "command"} failed`);
  return result.stdout;
}

function sameRemote(actual: string, expected: string): boolean {
  return actual.trim().replace(/\/$/, "") === expected.trim().replace(/\/$/, "");
}

async function prepareExisting(workspace: string, remote: string): Promise<boolean> {
  const entries = await readdir(workspace);
  if (entries.length === 0) {
    await git(["clone", "--no-checkout", "--origin", "origin", remote, workspace]);
    return true;
  }
  if ((await git(["rev-parse", "--is-inside-work-tree"], workspace)) !== "true") invalid("workspace_invalid", "workspace is not a Git worktree");
  const top = resolve(await git(["rev-parse", "--show-toplevel"], workspace));
  if (top !== resolve(workspace)) invalid("workspace_invalid", "workspace is not the checkout root");
  const actualRemote = await git(["remote", "get-url", "origin"], workspace);
  if (!sameRemote(actualRemote, remote)) invalid("repository_mismatch", "workspace origin does not match the enrolled repository");
  return false;
}

async function requireBaseCommit(workspace: string, baseCommit: string): Promise<void> {
  const result = await gitResult(["cat-file", "-e", `${baseCommit}^{commit}`], workspace);
  if (result.code !== 0) invalid("base_commit_unavailable", "requested base commit is not present in the checkout");
}

async function validateInputLocation(inputFile: string, policy: CheckoutPolicy, workspaceRoot: string): Promise<void> {
  let controlRoot: string;
  let inputPath: string;
  let inputParent: string;
  try {
    controlRoot = await realpath(policy.control_root);
    inputPath = resolve(inputFile);
    const details = await lstat(inputPath);
    if (details.isSymbolicLink() || !details.isFile()) invalid("input_location_invalid", "checkout input must be a regular file");
    inputParent = await realpath(dirname(inputPath));
  } catch {
    invalid("input_location_invalid", "checkout input location could not be inspected");
  }
  if (!insideOrSelf(controlRoot, inputParent)) invalid("input_location_invalid", "checkout input is outside the trusted control_root");
  if (insideOrSelf(workspaceRoot, inputParent)) invalid("input_location_invalid", "checkout input must be outside the worker workspace");
}

function insideOrSelf(root: string, target: string): boolean {
  return root === target || inside(root, target);
}

export async function prepareTrustedCheckout(options: CheckoutOptions): Promise<TrustedCheckoutResult> {
  if (!options.inputFile?.trim()) invalid("input_missing", "checkout requires a per-attempt input file");
  const context = readIssueContext(options.context);
  const input = parseInput(await readJsonFile(options.inputFile, INPUT_MAX_BYTES, "input"));
  const policyPath = options.policyFile?.trim() || process.env.CODEX_ORCHESTRATION_CHECKOUT_POLICY?.trim();
  if (!policyPath) invalid("policy_missing", "checkout requires CODEX_ORCHESTRATION_CHECKOUT_POLICY or --policy");
  const policy = parsePolicy(await readJsonFile(policyPath, INPUT_MAX_BYTES, "policy"));
  const contextRepo = contextRepository(context);
  if (input.assignment_id !== context.id) invalid("assignment_mismatch", "checkout assignment_id does not match issue context");
  const repository = input.repository || contextRepo;
  if (!REPOSITORY_PATTERN.test(repository)) invalid("repository_invalid", "repository must use OWNER/REPOSITORY form");
  if (repository.toLowerCase() !== contextRepo.toLowerCase()) invalid("repository_mismatch", "checkout repository does not match issue context");
  const configured = policy.repositories[repository.toLowerCase()];
  if (!configured) invalid("repository_not_enrolled", "repository is not in the trusted checkout policy");
  if (!COMMIT_PATTERN.test(input.base_commit)) invalid("base_commit_invalid", "base_commit must be a full Git commit SHA");
  const workspace = await resolveWorkspace(policy.workspace_root, input.workspace);
  await validateInputLocation(options.inputFile, policy, workspace.root);
  let cloned = false;
  try {
    if (workspace.exists) {
      cloned = await prepareExisting(workspace.workspace, configured.remote);
    } else {
      await mkdir(dirname(workspace.workspace), { recursive: true });
      await git(["clone", "--no-checkout", "--origin", "origin", configured.remote, workspace.workspace]);
      cloned = true;
    }
    await requireBaseCommit(workspace.workspace, input.base_commit);
    if (cloned) {
      await git(["checkout", "--detach", "--force", input.base_commit], workspace.workspace);
    } else {
      const current = await git(["rev-parse", "HEAD"], workspace.workspace);
      if (current.toLowerCase() !== input.base_commit.toLowerCase() && (await gitResult(["merge-base", "--is-ancestor", input.base_commit, current], workspace.workspace)).code !== 0) {
        invalid("base_commit_mismatch", "existing checkout is not based on the enrolled base commit");
      }
    }
    const head = await git(["rev-parse", "HEAD"], workspace.workspace);
    if (cloned && head.toLowerCase() !== input.base_commit.toLowerCase()) invalid("checkout_failed", "checkout did not reach the requested base commit");
  } catch (error) {
    if (cloned) await rm(workspace.workspace, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return {
    issue_id: context.id,
    identifier: context.identifier,
    assignment_id: input.assignment_id,
    attempt_id: input.attempt_id,
    repository,
    base_commit: input.base_commit,
    workspace: workspace.workspace
  };
}

