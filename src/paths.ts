import { resolve, win32 } from "node:path";

export function toWslPath(input: string): string {
  const absolute = win32.resolve(input);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(absolute);
  if (!match) throw new Error("plugin path must be on a local Windows drive");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function resolvedScriptPath(input: string | undefined): string {
  return toWslPath(input ?? resolve("mcp/server.mjs"));
}
