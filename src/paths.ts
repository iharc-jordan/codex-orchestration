import { statSync } from "node:fs";
import { resolve, win32 } from "node:path";

export function toWslPath(input: string): string {
  const absolute = win32.resolve(input);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) throw new Error("plugin path must be on a local Windows drive");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function toWslServicePath(input: string): string {
  if (input.startsWith("/")) return input;
  return toWslPath(input);
}

export function fromWslPath(input: string): string {
  const match = /^\/mnt\/([A-Za-z])\/(.*)$/.exec(input);
  if (!match) throw new Error("WSL path must be on a local Windows drive");
  return win32.resolve(`${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`);
}

export function resolvedScriptPath(input: string | undefined): string {
  return toWslPath(assertMcpEntrypoint(input));
}

export function assertMcpEntrypoint(input: string | undefined): string {
  const candidate = input ?? resolve("mcp/server.mjs");
  const hostPath = /^\/mnt\/[A-Za-z]\//.test(candidate)
    ? fromWslPath(candidate)
    : /^[A-Za-z]:[\\/]/.test(candidate)
      ? win32.resolve(candidate)
      : resolve(candidate);
  let details;
  try {
    details = statSync(hostPath);
  } catch {
    throw new Error(`MCP server entrypoint is missing from the installed plugin package: ${hostPath}. Reinstall the plugin package or refresh its installation.`);
  }
  if (!details.isFile()) throw new Error(`MCP server entrypoint is not a regular file: ${hostPath}. Reinstall the plugin package or refresh its installation.`);
  return hostPath;
}
