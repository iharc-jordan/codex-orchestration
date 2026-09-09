import { validateConfig } from "./config.js";

const command = process.argv[2];
if (command !== "validate-config") {
  console.error("Usage: codex-orchestration validate-config");
  process.exitCode = 2;
} else {
  const diagnostic = await validateConfig();
  console.log(JSON.stringify(diagnostic, null, 2));
  process.exitCode = diagnostic.valid ? 0 : 1;
}
