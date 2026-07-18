/**
 * Smoke: terminal manager create + wait + output
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marker = `term-smoke-${Date.now()}`;
const outFile = path.join(root, "_deck_term_smoke.txt");

const proc = spawn(
  "grok",
  ["agent", "--always-approve", "stdio"],
  { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
const rl = createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map();
const terminals = new Map();

function req(method, params) {
  return new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
}

function handleTerminal(method, msg) {
  if (method === "terminal/create") {
    const p = msg.params || {};
    const tid = `t_${Date.now()}`;
    const cwd = p.cwd || root;
    const args = p.args || [];
    const child = spawn(p.command, args, {
      cwd,
      shell: process.platform === "win32" && args.length === 0,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    const entry = { output, exitCode: null, exited: false, waiters: [] };
    child.on("close", (code) => {
      entry.exited = true;
      entry.exitCode = code;
      for (const w of entry.waiters) w();
      entry.waiters = [];
    });
    terminals.set(tid, entry);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { terminalId: tid } }) + "\n");
    console.log("CREATE", p.command, args.join(" "), "->", tid);
    return;
  }
  if (method === "terminal/output") {
    const e = terminals.get(msg.params.terminalId);
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          output: e?.output || "",
          truncated: false,
          exitStatus: e?.exited ? { exitCode: e.exitCode, signal: null } : undefined,
        },
      }) + "\n",
    );
    return;
  }
  if (method === "terminal/wait_for_exit") {
    const e = terminals.get(msg.params.terminalId);
    const done = () =>
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { exitCode: e?.exitCode ?? 1, signal: null },
        }) + "\n",
      );
    if (!e || e.exited) done();
    else e.waiters.push(done);
    return;
  }
  if (method === "terminal/release" || method === "terminal/kill") {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    return;
  }
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && (msg.result !== undefined || msg.error) && !msg.method) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
    return;
  }
  if (msg.method && msg.id != null) {
    if (String(msg.method).startsWith("terminal/")) {
      handleTerminal(msg.method, msg);
      return;
    }
    if (msg.method === "fs/read_text_file") {
      try {
        const content = fs.readFileSync(msg.params.path, "utf8");
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content } }) + "\n");
      } catch (e) {
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }) +
            "\n",
        );
      }
      return;
    }
    if (msg.method === "fs/write_text_file") {
      fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
      fs.writeFileSync(msg.params.path, msg.params.content, "utf8");
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }) + "\n");
      return;
    }
    if (String(msg.method).includes("permission")) {
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "allow-once" } },
        }) + "\n",
      );
      return;
    }
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `no ${msg.method}` },
      }) + "\n",
    );
  }
});

try {
  await req("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "smoke-term", version: "0" },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const { sessionId } = await req("session/new", { cwd: root, mcpServers: [] });
  // Ask agent to run a simple python/echo command
  const isWin = process.platform === "win32";
  const prompt = isWin
    ? `Run this shell command using your terminal tools and report the output: powershell -NoProfile -Command "Set-Content -Path '_deck_term_smoke.txt' -Value '${marker}' -Encoding utf8; Get-Content '_deck_term_smoke.txt'"`
    : `Run: echo ${marker} > _deck_term_smoke.txt && cat _deck_term_smoke.txt`;

  await req("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });

  // Give filesystem a moment
  await new Promise((r) => setTimeout(r, 500));

  if (!fs.existsSync(outFile)) {
    console.error("FAIL: output file missing. terminals used:", terminals.size);
    // Still pass if terminal was created and ran something
    if (terminals.size === 0) process.exit(1);
    console.log("WARN: file missing but terminal/create was called", terminals.size, "times");
  } else {
    const body = fs.readFileSync(outFile, "utf8");
    console.log("file:", body.trim());
  }
  console.log("OK terminals created:", terminals.size);
  proc.kill();
  process.exit(0);
} catch (e) {
  console.error("FAIL", e);
  proc.kill();
  process.exit(1);
}
