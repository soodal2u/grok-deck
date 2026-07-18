import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

// Inline minimal client to avoid TS loader issues
class Client extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.proc = spawn("grok", ["agent", "stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", (b) => this.emit("stderr", b.toString()));
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "smoke", version: "0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const result = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
    this.sessionId = result.sessionId;
    return result;
  }

  onLine(line) {
    const msg = JSON.parse(line);
    if (msg.id != null && (msg.result !== undefined || msg.error) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "session/update") {
      this.emit("update", msg.params?.update);
    }
    if (msg.method && msg.id != null) {
      // auto-allow permissions in smoke
      if (String(msg.method).includes("permission")) {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { outcome: { outcome: "selected", optionId: "allow-once" } },
        });
      } else {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `not implemented: ${msg.method}` },
        });
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async prompt(text) {
    return this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  stop() {
    this.proc?.kill();
  }
}

const c = new Client(process.cwd());
let text = "";
c.on("update", (u) => {
  if (u?.sessionUpdate === "agent_message_chunk") {
    text += u.content?.text || "";
    process.stdout.write(u.content?.text || "");
  } else if (u?.sessionUpdate) {
    console.log("\n[update]", u.sessionUpdate, u.title || u.tool || "");
  }
});
c.on("stderr", (t) => console.error("[stderr]", t.slice(0, 300)));

try {
  const session = await c.start();
  console.log("session", session.sessionId);
  const result = await c.prompt("Reply with exactly the single word: pong");
  console.log("\nresult", result);
  console.log("collected text:", JSON.stringify(text));
  c.stop();
  process.exit(0);
} catch (e) {
  console.error("FAIL", e);
  c.stop();
  process.exit(1);
}
