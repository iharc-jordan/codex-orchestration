import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { orchestrationPaths } from "./paths.js";
import { readRequirements, RequirementsError } from "./requirements.js";

export interface RequirementSession {
  cwd: string;
  fingerprint: string;
  pendingTurn?: string;
  acknowledgedTurn?: string;
  reminderPrompt?: string;
}

function statePath(sessionId: string, testRoot?: string): string {
  if (!sessionId) throw new RequirementsError("requirements_session_missing", "Native session identity is required");
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(orchestrationPaths(process.env, testRoot).state, "requirements-sessions", `${id}.json`);
}

export async function readRequirementSession(sessionId: string, testRoot?: string): Promise<RequirementSession | undefined> {
  try { return JSON.parse(await readFile(statePath(sessionId, testRoot), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export async function writeRequirementSession(sessionId: string, state: RequirementSession, testRoot?: string): Promise<void> {
  const path = statePath(sessionId, testRoot);
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function acknowledgeRequirements(sessionId: string, args: {cwd: string; turn_id: string; fingerprint: string; outcome: "updated" | "unchanged"}, testRoot?: string): Promise<{acknowledged: true}> {
  if (!args || typeof args.cwd !== "string" || typeof args.turn_id !== "string" || !["updated", "unchanged"].includes(args.outcome)) {
    throw new RequirementsError("requirements_ack_invalid", "cwd, turn_id, fingerprint and outcome are required");
  }
  const state = await readRequirementSession(sessionId, testRoot);
  const current = await readRequirements(args.cwd, { testRoot });
  if (!state || state.pendingTurn !== args.turn_id) throw new RequirementsError("requirements_turn_mismatch", "Acknowledge the current user turn only; no pending user turn was recorded or the supplied turn differs");
  const original = await readRequirements(state.cwd, { testRoot });
  if (original.path !== current.path) throw new RequirementsError("requirements_project_mismatch", "Acknowledge this task's project only");
  if (current.fingerprint !== args.fingerprint) throw new RequirementsError("requirements_changed", "Read the current requirements before acknowledging");
  await writeRequirementSession(sessionId, {...state, fingerprint: current.fingerprint, acknowledgedTurn: args.turn_id, reminderPrompt: undefined}, testRoot);
  return { acknowledged: true };
}
