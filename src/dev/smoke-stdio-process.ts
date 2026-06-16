import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Process-level stdio smoke: launches the ADVERTISED local entrypoint exactly as
 * an MCP client would — `node --no-warnings src/interfaces/mcp/stdio-bridge.ts` —
 * and proves stdout is a pure JSON-RPC channel: no pnpm lifecycle banner, no stray
 * log line. The in-memory `smoke-stdio.ts` exercises local server semantics but
 * cannot catch stdout contamination from a script wrapper (e.g. `pnpm run bridge`
 * printing `> smart-fetch@… bridge` to stdout); this one launches the real process.
 *
 * It performs only the protocol handshake + `tools/list` (no smart_fetch call), so
 * it stays hermetic: no network egress, no public fixture. Audit/ready logs must
 * appear on stderr only.
 */

const ENTRY = "src/interfaces/mcp/stdio-bridge.ts";
const PROTOCOL_VERSION = "2025-11-25";
const RESPONSE_TIMEOUT_MS = 15_000;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: unknown;
  method?: string;
}

interface ToolEntry {
  name?: string;
  inputSchema?: { additionalProperties?: unknown };
}

const child = spawn(process.execPath, ["--no-warnings", ENTRY], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, SMART_FETCH_FLAVOR: "local-binary" },
});

if (!child.stdin || !child.stdout || !child.stderr) {
  throw new Error("stdio process smoke: failed to open stdio pipes for the bridge process");
}
const { stdin, stdout, stderr } = child;

const stdoutLines: string[] = [];
const contaminated: string[] = [];
const stderrChunks: string[] = [];
const received = new Map<number | string, JsonRpcMessage>();
const waiters = new Map<number | string, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
let stdoutBuffer = "";
let childExited = false;

stdout.setEncoding("utf8");
stdout.on("data", (chunk: string) => {
  stdoutBuffer += chunk;
  let newline = stdoutBuffer.indexOf("\n");
  while (newline >= 0) {
    consumeLine(stdoutBuffer.slice(0, newline));
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    newline = stdoutBuffer.indexOf("\n");
  }
});
stderr.setEncoding("utf8");
stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

child.on("error", (error: Error) => failAllWaiters(new Error(`bridge process error: ${error.message}`)));
child.on("exit", (code, signal) => {
  childExited = true;
  if (stdoutBuffer.trim() !== "") {
    consumeLine(stdoutBuffer);
    stdoutBuffer = "";
  }
  failAllWaiters(new Error(`bridge process exited early (code=${code} signal=${signal})\nstderr:\n${stderrText()}`));
});

function consumeLine(raw: string): void {
  const line = raw.replace(/\r$/, "").trim();
  if (line === "") return;
  stdoutLines.push(line);
  let parsed: JsonRpcMessage;
  try {
    parsed = JSON.parse(line) as JsonRpcMessage;
  } catch {
    contaminated.push(line);
    return;
  }
  if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
    contaminated.push(line);
    return;
  }
  if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
    received.set(parsed.id, parsed);
    const waiter = waiters.get(parsed.id);
    if (waiter) {
      waiters.delete(parsed.id);
      waiter.resolve(parsed);
    }
  }
}

function failAllWaiters(error: Error): void {
  for (const [id, waiter] of waiters) {
    waiters.delete(id);
    waiter.reject(error);
  }
}

function stderrText(): string {
  return stderrChunks.join("");
}

function send(message: Record<string, unknown>): void {
  if (!stdin.writable) return;
  stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponse(id: number): Promise<JsonRpcMessage> {
  const existing = received.get(id);
  if (existing) return Promise.resolve(existing);
  if (childExited) {
    return Promise.reject(new Error(`bridge exited before responding to id=${id}\nstderr:\n${stderrText()}`));
  }
  return new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out after ${RESPONSE_TIMEOUT_MS}ms waiting for JSON-RPC id=${id}\nstderr:\n${stderrText()}`));
    }, RESPONSE_TIMEOUT_MS);
    waiters.set(id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<ToolEntry> {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "smart-fetch-stdio-process-smoke", version: "0.1.0" },
    },
  });
  await waitForResponse(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const list = await waitForResponse(2);

  const result = list.result as { tools?: ToolEntry[] } | undefined;
  const tools = result?.tools ?? [];
  const tool = tools.find((entry) => entry.name === "smart_fetch");
  if (!tool) {
    const names = tools.map((entry) => entry.name).join(", ") || "none";
    throw new Error(`tools/list did not advertise smart_fetch over stdio (saw: ${names})`);
  }
  if (tool.inputSchema?.additionalProperties !== false) {
    throw new Error("stdio smart_fetch inputSchema is not strict (additionalProperties !== false)");
  }
  if (contaminated.length > 0) {
    throw new Error(
      `stdout is NOT a pure JSON-RPC channel — ${contaminated.length} non-protocol line(s):\n${contaminated.join("\n")}`,
    );
  }
  if (stdoutLines.length === 0) {
    throw new Error("no JSON-RPC frames observed on stdout; bridge produced no protocol output");
  }
  if (!stderrText().includes("local stdio bridge ready")) {
    throw new Error(`bridge never logged its stderr ready line\nstderr:\n${stderrText()}`);
  }
  return tool;
}

let exitCode = 0;
try {
  const tool = await run();
  console.log("--- smart-fetch local stdio bridge process smoke ---");
  console.log(`advertised command: node --no-warnings ${ENTRY}`);
  console.log(`stdout JSON-RPC frames: ${stdoutLines.length} (0 non-protocol lines)`);
  console.log("stdout is a pure JSON-RPC channel: no pnpm banner, no stray logs");
  console.log(`smart_fetch advertised over stdio with strict schema: ${tool.name === "smart_fetch" ? "yes" : "no"}`);
  console.log("audit/ready logs observed on stderr only");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`stdio process smoke FAILED: ${message}\n`);
  exitCode = 1;
} finally {
  try { stdin.end(); } catch { /* already closed */ }
  if (!childExited) child.kill("SIGTERM");
  await delay(200);
  if (!childExited) child.kill("SIGKILL");
}

process.exit(exitCode);
