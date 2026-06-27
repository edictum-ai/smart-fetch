#!/usr/bin/env node
// captatum launcher — the package `bin`. Re-execs Node 24 on the compiled stdio
// bridge (dist/ — Node 24 refuses to type-strip .ts inside node_modules, so the
// npm package ships compiled .js; the repo itself runs .ts natively for dev).
// npm/npx runs this; it blocks with stdio inherited so the MCP client owns the
// process lifecycle (stdin/stdout = JSON-RPC, stderr = logs).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (!Number.isInteger(major) || major < 24) {
  process.stderr.write(`captatum requires Node.js >= 24 (got ${process.versions.node}).\n`);
  process.stderr.write("Use a recent Node, or run the hosted gateway (ghcr.io/edictum-ai/captatum).\n");
  process.exit(1);
}

const entry = fileURLToPath(new URL("../dist/interfaces/mcp/stdio-bridge.js", import.meta.url));
const result = spawnSync(process.execPath, ["--no-warnings", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
