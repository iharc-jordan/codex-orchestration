import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** All private plugin state has one Windows root and no alternate path translation. */
export interface OrchestrationPaths {
  root: string;
  releases: string;
  config: string;
  state: string;
  logs: string;
  workspaces: string;
  current: string;
  previous: string;
  token: string;
  /** Private provider environment captured for the controller process. */
  controllerEnvironment: string;
  bridgeConfig: string;
  /** Private mapping from repository roots to canonical requirement roots. */
  requirementsConfig: string;
  launcher: string;
  runner: string;
  taskXml: string;
  metadata: string;
  mutex: string;
}

export function orchestrationPaths(env: NodeJS.ProcessEnv = process.env, testRoot?: string): OrchestrationPaths {
  const localAppData = env.LOCALAPPDATA?.trim() || join(env.USERPROFILE?.trim() || homedir(), "AppData", "Local");
  const root = resolve(testRoot || join(localAppData, "CodexOrchestration"));
  const config = join(root, "config");
  const state = join(root, "state");
  return {
    root,
    releases: join(root, "releases"),
    config,
    state,
    logs: join(root, "logs"),
    workspaces: join(root, "workspaces"),
    current: join(root, "current"),
    previous: join(root, "previous"),
    token: join(config, "token"),
    controllerEnvironment: join(config, "controller-env.json"),
    bridgeConfig: join(config, "config.json"),
    requirementsConfig: join(config, "requirements.json"),
    launcher: join(root, "run-orchestration.cmd"),
    runner: join(root, "run-orchestration.ps1"),
    taskXml: join(root, "task.xml"),
    metadata: join(root, "installation.json"),
    mutex: join(state, "lifecycle.lock")
  };
}

export function assertMcpEntrypoint(input: string | undefined): string {
  const candidate = input ?? resolve("mcp/server.mjs");
  const hostPath = isAbsolute(candidate) ? resolve(candidate) : resolve(candidate);
  let details;
  try {
    details = statSync(hostPath);
  } catch {
    throw new Error(`MCP server entrypoint is missing from the installed plugin package: ${hostPath}. Reinstall the plugin package or refresh its installation.`);
  }
  if (!details.isFile()) throw new Error(`MCP server entrypoint is not a regular file: ${hostPath}. Reinstall the plugin package or refresh its installation.`);
  return hostPath;
}
