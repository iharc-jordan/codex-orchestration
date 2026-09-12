import { runBridge } from "../../dist/server.js";

const root = process.argv[2];
if (!root) throw new Error("test root is required");
await runBridge(root);
