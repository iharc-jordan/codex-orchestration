import { runCli } from "../../dist/cli.js";

const [, , root, ...args] = process.argv;
if (!root) throw new Error("test root is required");
process.exitCode = await runCli(args, root);
