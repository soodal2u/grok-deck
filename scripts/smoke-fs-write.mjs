/**
 * Smoke: agent must write a file via client fs/write_text_file (with auto-allow).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "_deck_smoke_write.txt");
const marker = `smoke-${Date.now()}`;

if (fs.existsSync(target)) fs.unlinkSync(target);

const proc = spawn("grok", ["agent", "--always-approve", "stdio"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const rl = createInterface({ input: proc.stdout });
let id = 1;
const pending = new Map();
const writes = [];

function req(method, params) {
  return new Promise((resolve, reject) => {
    const i = id++;
    pending.set(i, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
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
    if (msg.method === "fs/read_text_file") {
      try {
        const content = fs.readFileSync(msg.params.path, "utf8");
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content } }) + "\n");
      } catch (e) {
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: e.message },
          }) + "\n",
        );
      }
      return;
    }
    if (msg.method === "fs/write_text_file") {
      fs.mkdirSync(path.dirname(msg.params.path), { recursive: true });
      fs.writeFileSync(msg.params.path, msg.params.content, "utf8");
      writes.push(msg.params.path);
      console.log("WROTE", msg.params.path);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }) + "\n");
      return;
    }
    if (String(msg.method).includes("permission")) {
      const opts = msg.params?.options || [];
      const allow =
        opts.find((o) => String(o.kind || o.optionId).includes("allow")) || opts[0];
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: allow?.optionId || "allow-once" } },
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
    clientInfo: { name: "smoke-fs", version: "0" },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const { sessionId } = await req("session/new", { cwd: root, mcpServers: [] });
  await req("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: `Write exactly this content to the file _deck_smoke_write.txt in the project root (overwrite if exists):\n${marker}\nDo not explain much.`,
      },
    ],
  });

  if (!fs.existsSync(target)) {
    console.error("FAIL: file not created. writes=", writes);
    process.exit(1);
  }
  const body = fs.readFileSync(target, "utf8");
  if (!body.includes(marker)) {
    console.error("FAIL: marker missing", body);
    process.exit(1);
  }
  console.log("OK", body.trim());
  proc.kill();
  process.exit(0);
} catch (e) {
  console.error("FAIL", e);
  proc.kill();
  process.exit(1);
}
