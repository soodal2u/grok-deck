import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import type {
  DeckMode,
  FileDiff,
  PermissionOption,
  StreamEvent,
  TokenUsage,
  ToolCallView,
} from "@grok-deck/shared";
import { TerminalManager } from "./terminal-manager";
import { GhostGit } from "./ghost-git";
import { loadUsage, saveUsage } from "./usage-store";

export { GhostGit, ghostStoreDir, ghostWorkspaceKey, lineAddDel } from "./ghost-git";

export type AcpClientOptions = {
  cwd: string;
  grokPath?: string;
  model?: string;
  /** Initial deck mode (normal / plan / yolo) */
  mode?: DeckMode;
  /** CLI --reasoning-effort */
  reasoningEffort?: "low" | "medium" | "high";
  env?: NodeJS.ProcessEnv;
};

type JsonRpcId = number | string;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type LocalPermissionWaiter = {
  resolve: (optionId: string) => void;
  reject: (err: Error) => void;
};

type RpcPermissionWaiter = {
  kind: "rpc";
  rpcId: JsonRpcId;
};

type PendingPermission =
  | { kind: "local"; waiter: LocalPermissionWaiter }
  | RpcPermissionWaiter;

/**
 * ACP JSON-RPC client over `grok agent stdio`.
 *
 * Critical: when we advertise fs capabilities, Grok **calls back** into the
 * client via `fs/read_text_file` and `fs/write_text_file`. Rejecting those
 * methods is what made file writes fail before.
 */
export class GrokAcpClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private nextId = 1;
  private nextLocalPermId = 100_000;
  private pending = new Map<JsonRpcId, Pending>();
  private pendingPermissions = new Map<number, PendingPermission>();
  private sessionId: string | null = null;
  private closed = false;
  private mode: DeckMode;
  private cwd: string;
  /** After user picks "Always allow edits" once in Normal mode */
  private autoAllowEdits = false;
  private contextLimit = 500_000;
  private lastUsage: TokenUsage | null = null;
  private turnStartedAt = 0;
  private terminals: TerminalManager;
  private ghost: GhostGit;
  private availableCommands: Array<{ name: string; description: string; hint?: string }> = [];
  private reasoningEffort: "low" | "medium" | "high";

  constructor(private readonly options: AcpClientOptions) {
    super();
    this.cwd = resolve(options.cwd);
    this.mode = options.mode ?? "normal";
    this.reasoningEffort = options.reasoningEffort ?? "high";
    if (this.mode === "yolo") this.autoAllowEdits = true;
    this.terminals = new TerminalManager(this.cwd);
    this.ghost = new GhostGit(this.cwd);
  }

  getGhost() {
    return this.ghost;
  }

  getCommands() {
    return this.availableCommands;
  }

  getReasoningEffort() {
    return this.reasoningEffort;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getMode(): DeckMode {
    return this.mode;
  }

  getCwd(): string {
    return this.cwd;
  }

  /**
   * Cycle Normal → Plan → Always-approve (same as CLI Shift+Tab).
   */
  async setMode(mode: DeckMode): Promise<DeckMode> {
    this.mode = mode;
    if (mode === "yolo") this.autoAllowEdits = true;
    if (mode === "normal") this.autoAllowEdits = false;
    this.emitEvent({ type: "mode", mode });

    if (!this.sessionId || !this.proc) return mode;

    // Best-effort: tell agent about always-approve via slash command semantics
    // and session/set_mode where supported.
    try {
      if (mode === "yolo") {
        await this.request("session/set_mode", {
          sessionId: this.sessionId,
          modeId: "bypassPermissions",
        }).catch(() => undefined);
      } else if (mode === "plan") {
        await this.request("session/set_mode", {
          sessionId: this.sessionId,
          modeId: "plan",
        }).catch(() => undefined);
      } else {
        await this.request("session/set_mode", {
          sessionId: this.sessionId,
          modeId: "default",
        }).catch(() => undefined);
      }
    } catch {
      /* optional */
    }

    this.emitEvent({
      type: "status",
      message:
        mode === "yolo"
          ? "Mode: Always-approve (auto tools)"
          : mode === "plan"
            ? "Mode: Plan (writes blocked)"
            : "Mode: Normal (ask before edits)",
    });

    return mode;
  }

  async start(): Promise<{ sessionId: string }> {
    if (this.proc) throw new Error("ACP client already started");
    await this.startProcessOnly();

    const result = (await this.request("session/new", {
      cwd: this.cwd,
      mcpServers: [],
    })) as { sessionId?: string };

    if (!result?.sessionId) {
      throw new Error("session/new did not return sessionId");
    }

    this.sessionId = result.sessionId;

    if (this.mode !== "normal") {
      await this.setMode(this.mode);
    } else {
      this.emitEvent({ type: "mode", mode: this.mode });
    }

    await this.emitRestoredProjectState();

    return { sessionId: this.sessionId };
  }

  /**
   * Resume an existing Grok session by ID (ACP session/load).
   * Falls back to session/new if load fails (e.g. path issues).
   */
  async loadSession(sessionId: string): Promise<{ sessionId: string; loaded: boolean }> {
    if (!this.proc) {
      // start process first without creating a new session
      await this.startProcessOnly();
    }

    try {
      await this.request("session/load", {
        sessionId,
        cwd: this.cwd,
        mcpServers: [],
      });
      this.sessionId = sessionId;
      this.emitEvent({ type: "status", message: `Resumed session ${sessionId.slice(0, 8)}…` });
      this.emitEvent({ type: "mode", mode: this.mode });
      await this.emitRestoredProjectState();
      return { sessionId, loaded: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent({
        type: "status",
        message: `Could not resume agent context (${message}). Showing history; new turns start a fresh agent session.`,
      });
      // Fall back to a fresh session for continued work
      const created = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: [],
      }) as { sessionId?: string };
      if (!created?.sessionId) throw new Error("session/new failed after load failure");
      this.sessionId = created.sessionId;
      await this.emitRestoredProjectState();
      return { sessionId: created.sessionId, loaded: false };
    }
  }

  private async startProcessOnly(): Promise<void> {
    if (this.proc) return;

    const grokPath = this.options.grokPath || "grok";
    const args = ["agent"];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.reasoningEffort) args.push("--reasoning-effort", this.reasoningEffort);
    if (this.mode === "yolo") args.push("--always-approve");
    args.push("stdio");

    this.proc = spawn(grokPath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));

    this.proc.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString("utf8").trim();
      if (text) this.emit("stderr", text);
    });

    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error(`grok agent exited (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
      for (const [, perm] of this.pendingPermissions) {
        if (perm.kind === "local") {
          perm.waiter.reject(new Error("Agent exited during permission wait"));
        }
      }
      this.pendingPermissions.clear();
      this.emit("exit", { code, signal });
    });

    this.proc.on("error", (err) => this.emit("error", err));
    this.closed = false;

    const init = (await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "grok-deck",
        title: "Grok Deck",
        version: "0.3.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    })) as Record<string, unknown>;

    const limit = extractContextLimit(init);
    if (limit) {
      this.contextLimit = limit;
      this.emitEvent({ type: "context_limit", limit });
    }
  }

  /**
   * Send a user turn. `content` may include text / image / resource_link ACP blocks.
   * When omitted, `text` is sent as a single text block.
   */
  async prompt(
    text: string,
    content?: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.sessionId) throw new Error("No active session");

    this.turnStartedAt = Date.now();
    const promptBlocks =
      content && content.length > 0
        ? content
        : [{ type: "text", text }];
    const result = (await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: promptBlocks,
    })) as { stopReason?: string; _meta?: Record<string, unknown> };

    const usage = extractUsage(result?._meta, this.contextLimit);
    if (usage) {
      this.lastUsage = usage;
      this.emitEvent({ type: "usage", usage });
      void saveUsage(this.cwd, usage);
    }

    // Ghost git: one commit per finished agent turn (persisted under ~/.grokdeck/ghost)
    const ghostCommit = await this.ghost.commitTurn(
      result?.stopReason ? `Turn (${result.stopReason})` : "Agent turn",
    );
    if (ghostCommit) {
      this.emitEvent({
        type: "ghost_commit",
        commit: {
          id: ghostCommit.id,
          createdAt: ghostCommit.createdAt,
          message: ghostCommit.message,
          fileCount: ghostCommit.changes.length,
          paths: ghostCommit.changes.map((c) => c.path),
          files: ghostCommit.changes.map((c) => ({
            path: c.path,
            add: c.add ?? 0,
            del: c.del ?? 0,
          })),
        },
      });
    }

    this.emitEvent({
      type: "turn_done",
      stopReason: result?.stopReason,
      usage: usage || this.lastUsage || undefined,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : undefined,
      ghost: await this.ghost.status(),
    });
  }

  async undoGhost(): Promise<{ ok: boolean; message: string }> {
    const result = await this.ghost.undoIncludingPending();
    if (result.ok && result.commit) {
      this.emitEvent({
        type: "ghost_undo",
        commit: {
          id: result.commit.id,
          createdAt: result.commit.createdAt,
          message: result.commit.message,
          fileCount: result.commit.changes.length,
          paths: result.commit.changes.map((c) => c.path),
        },
      });
      // Refresh diffs in UI — signal file restores
      for (const ch of result.commit.changes) {
        this.emitEvent({
          type: "file_changed",
          path: ch.path,
          action: "write",
          bytes: ch.previous?.length,
        });
      }
    }
    this.emitEvent({ type: "status", message: result.message });
    return { ok: result.ok, message: result.message };
  }

  async ghostStatus() {
    return this.ghost.status();
  }

  /**
   * Reload Ghost Git + last context usage from disk and push to UI.
   * Call after session start / resume so the project does not look "empty".
   */
  async emitRestoredProjectState(): Promise<void> {
    await this.ghost.ensureLoaded();
    const ghost = await this.ghost.status();
    this.emitEvent({ type: "ghost_status", ghost });

    const saved = await loadUsage(this.cwd);
    if (saved) {
      this.lastUsage = {
        ...saved,
        contextLimit: saved.contextLimit || this.contextLimit,
      };
      this.emitEvent({ type: "usage", usage: this.lastUsage });
    } else if (this.contextLimit) {
      this.emitEvent({
        type: "context_limit",
        limit: this.contextLimit,
      });
    }

    if (ghost.depth > 0) {
      this.emitEvent({
        type: "status",
        message: `Ghost Git · ${ghost.depth} commits ready`,
      });
    }
  }

  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    // Cancel any waiting local permissions
    for (const [id, perm] of this.pendingPermissions) {
      if (perm.kind === "local") {
        this.pendingPermissions.delete(id);
        perm.waiter.reject(new Error("Cancelled"));
      } else if (perm.kind === "rpc") {
        this.pendingPermissions.delete(id);
        this.send({
          jsonrpc: "2.0",
          id: perm.rpcId,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
    }
    try {
      await this.request("session/cancel", { sessionId: this.sessionId });
    } catch {
      /* best-effort */
    }
  }

  /**
   * User chose a permission option in the UI.
   */
  async respondPermission(requestId: number, optionId: string): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      // Might be a late click — ignore
      return;
    }
    this.pendingPermissions.delete(requestId);

    if (pending.kind === "local") {
      pending.waiter.resolve(optionId);
      return;
    }

    this.send({
      jsonrpc: "2.0",
      id: pending.rpcId,
      result: {
        outcome: {
          outcome: "selected",
          optionId,
        },
      },
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.terminals.disposeAll();
    for (const [, p] of this.pending) p.reject(new Error("Client stopped"));
    this.pending.clear();
    for (const [, perm] of this.pendingPermissions) {
      if (perm.kind === "local") perm.waiter.reject(new Error("Client stopped"));
      else {
        this.send({
          jsonrpc: "2.0",
          id: perm.rpcId,
          result: { outcome: { outcome: "cancelled" } },
        });
      }
    }
    this.pendingPermissions.clear();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.sessionId = null;
  }

  private async handleTerminalCreate(params: unknown): Promise<{ terminalId: string }> {
    const p = params as {
      command?: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
      cwd?: string | null;
      outputByteLimit?: number | null;
    };
    if (!p.command) throw new Error("terminal/create: missing command");

    if (this.mode === "plan") {
      throw new Error("Plan mode: terminal execution is blocked. Shift+Tab to Normal or Always-approve.");
    }

    // Normal mode: ask before running shell (same pattern as file writes)
    if (this.mode === "normal" && !this.autoAllowEdits) {
      const cmdline = [p.command, ...(p.args || [])].join(" ");
      const optionId = await this.askLocalPermission({
        title: `Run: ${p.command}`,
        detail: cmdline.slice(0, 800),
        path: p.cwd || this.cwd,
        toolCall: {
          id: `term_${Date.now()}`,
          title: cmdline.slice(0, 120),
          kind: "execute",
          status: "pending",
          input: { command: p.command, args: p.args, cwd: p.cwd },
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow (session)", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      if (optionId.includes("reject") || optionId === "cancel") {
        throw new Error("User rejected terminal command");
      }
      if (optionId.includes("always") || optionId.includes("allow_always")) {
        this.autoAllowEdits = true;
        this.emitEvent({
          type: "status",
          message: "Commands & edits will be auto-allowed for this session",
        });
      }
    }

    const result = this.terminals.create({
      command: p.command,
      args: p.args,
      env: p.env,
      cwd: p.cwd,
      outputByteLimit: p.outputByteLimit,
    });

    this.emitEvent({
      type: "status",
      message: `Terminal ${result.terminalId}: ${p.command}`,
    });
    return result;
  }

  private emitEvent(event: StreamEvent) {
    this.emit("event", event);
  }

  private onLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.emit("stderr", `non-json line: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Response to our request
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined) &&
      !msg.method
    ) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || "JSON-RPC error"));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server request (permission / fs / terminal)
    if (msg.method && msg.id !== undefined) {
      void this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    if (msg.method) {
      this.handleNotification(msg.method, msg.params);
    }
  }

  private handleNotification(method: string, params: unknown) {
    if (method === "session/update") {
      const p = params as { update?: Record<string, unknown> };
      if (p?.update) this.mapSessionUpdate(p.update);
      return;
    }
    if (method.startsWith("x.ai/") || method.startsWith("_x.ai/")) {
      this.emit("extension", { method, params });
    }
  }

  private mapSessionUpdate(update: Record<string, unknown>) {
    const kind = update.sessionUpdate as string | undefined;

    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content as { text?: string } | undefined;
        if (content?.text) this.emitEvent({ type: "text", text: content.text });
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content as { text?: string } | undefined;
        if (content?.text) this.emitEvent({ type: "thought", text: content.text });
        break;
      }
      case "user_message_chunk":
        // echo of user message — skip
        break;
      case "tool_call": {
        const call = normalizeToolCall(update);
        this.emitEvent({ type: "tool_call", call });
        for (const d of call.diffs || []) {
          this.emitEvent({ type: "diff", diff: d });
        }
        break;
      }
      case "tool_call_update": {
        const call = normalizeToolCall(update);
        this.emitEvent({ type: "tool_call_update", call });
        for (const d of call.diffs || []) {
          this.emitEvent({ type: "diff", diff: d });
        }
        break;
      }
      case "plan": {
        const entries = (update.entries as Array<Record<string, unknown>> | undefined) || [];
        this.emitEvent({
          type: "plan",
          entries: entries.map((e) => ({
            content: String(e.content ?? e.title ?? ""),
            status: e.status != null ? String(e.status) : undefined,
            priority: e.priority != null ? String(e.priority) : undefined,
          })),
        });
        break;
      }
      case "available_commands_update": {
        const cmds = Array.isArray(update.availableCommands)
          ? (update.availableCommands as Array<Record<string, unknown>>).map((c) => ({
              name: String(c.name || ""),
              description: String(c.description || ""),
              hint:
                c.input && typeof c.input === "object" && (c.input as { hint?: string }).hint
                  ? String((c.input as { hint?: string }).hint)
                  : undefined,
            }))
          : [];
        this.availableCommands = cmds.filter((c) => c.name);
        this.emitEvent({ type: "commands", commands: this.availableCommands });
        break;
      }
      case "usage_update": {
        const usage = extractUsage(update, this.contextLimit) || extractUsage(
          { usage: update },
          this.contextLimit,
        );
        if (usage) {
          this.lastUsage = usage;
          this.emitEvent({ type: "usage", usage });
          void saveUsage(this.cwd, usage);
        }
        break;
      }
      default:
        this.emit("raw_update", update);
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown) {
    try {
      if (
        method === "session/request_permission" ||
        method === "request_permission" ||
        method.endsWith("/request_permission")
      ) {
        await this.handleAgentPermission(id, params);
        return;
      }

      if (method === "fs/read_text_file") {
        const result = await this.handleReadTextFile(params);
        this.send({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method === "fs/write_text_file") {
        const result = await this.handleWriteTextFile(params);
        this.send({ jsonrpc: "2.0", id, result });
        return;
      }

      if (method === "terminal/create") {
        const result = await this.handleTerminalCreate(params);
        this.send({ jsonrpc: "2.0", id, result });
        return;
      }
      if (method === "terminal/output") {
        const p = params as { terminalId?: string };
        if (!p.terminalId) throw new Error("terminal/output: missing terminalId");
        this.send({ jsonrpc: "2.0", id, result: this.terminals.output(p.terminalId) });
        return;
      }
      if (method === "terminal/wait_for_exit") {
        const p = params as { terminalId?: string };
        if (!p.terminalId) throw new Error("terminal/wait_for_exit: missing terminalId");
        const status = await this.terminals.waitForExit(p.terminalId);
        this.send({ jsonrpc: "2.0", id, result: status });
        return;
      }
      if (method === "terminal/kill") {
        const p = params as { terminalId?: string };
        if (!p.terminalId) throw new Error("terminal/kill: missing terminalId");
        this.send({ jsonrpc: "2.0", id, result: this.terminals.kill(p.terminalId) });
        return;
      }
      if (method === "terminal/release") {
        const p = params as { terminalId?: string };
        if (!p.terminalId) throw new Error("terminal/release: missing terminalId");
        this.send({ jsonrpc: "2.0", id, result: this.terminals.release(p.terminalId) });
        return;
      }

      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not implemented by Grok Deck: ${method}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      });
    }
  }

  private async handleAgentPermission(rpcId: JsonRpcId, params: unknown): Promise<void> {
    const p = params as {
      toolCall?: Record<string, unknown>;
      options?: PermissionOption[];
      sessionId?: string;
    };

    const toolCall = p.toolCall ? normalizeToolCall(p.toolCall) : undefined;
    const options = normalizeOptions(p.options);

    // Auto-approve in YOLO
    if (this.mode === "yolo") {
      const allow = pickAllowOption(options, true);
      this.send({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "selected", optionId: allow } },
      });
      return;
    }

    // Plan: reject mutating tools
    if (this.mode === "plan" && isMutatingTool(toolCall)) {
      const reject = pickRejectOption(options);
      this.send({
        jsonrpc: "2.0",
        id: rpcId,
        result: { outcome: { outcome: "selected", optionId: reject } },
      });
      this.emitEvent({
        type: "status",
        message: "Plan mode blocked a mutating tool — Shift+Tab to leave Plan",
      });
      return;
    }

    const requestId = this.nextLocalPermId++;
    this.pendingPermissions.set(requestId, { kind: "rpc", rpcId });

    this.emitEvent({
      type: "permission_request",
      requestId,
      source: "agent",
      title: toolCall?.title || toolCall?.tool || "Tool permission",
      detail: summarizeTool(toolCall),
      toolCall,
      options,
      path: toolCall?.locations?.[0]?.path || extractPathFromInput(toolCall?.input),
    });

    // Wait is handled when UI calls respondPermission — do not resolve here.
    // The JSON-RPC response is sent from respondPermission.
  }

  private async handleReadTextFile(params: unknown): Promise<{ content: string }> {
    const p = params as { path?: string; line?: number; limit?: number };
    if (!p.path) throw new Error("fs/read_text_file: missing path");

    const abs = this.assertInWorkspace(p.path);
    let content = await readFile(abs, "utf8");

    if (p.line != null || p.limit != null) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, (p.line ?? 1) - 1);
      const end = p.limit != null ? start + p.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }

    this.emitEvent({ type: "file_changed", path: abs, action: "read", bytes: content.length });
    return { content };
  }

  private async handleWriteTextFile(params: unknown): Promise<null> {
    const p = params as { path?: string; content?: string };
    if (!p.path) throw new Error("fs/write_text_file: missing path");
    if (typeof p.content !== "string") throw new Error("fs/write_text_file: missing content");

    const abs = this.assertInWorkspace(p.path);

    // Plan mode: never write
    if (this.mode === "plan") {
      throw new Error("Plan mode: file writes are blocked. Shift+Tab to Normal or Always-approve.");
    }

    // Normal mode: ask the user (Grok often does NOT send session/request_permission
    // for client-side fs writes — the client must gate).
    const needsAsk = this.mode === "normal" && !this.autoAllowEdits;
    if (needsAsk) {
      let oldText: string | null = null;
      try {
        oldText = await readFile(abs, "utf8");
      } catch {
        oldText = null;
      }

      this.emitEvent({
        type: "diff",
        diff: { path: abs, oldText, newText: p.content },
      });

      const optionId = await this.askLocalPermission({
        title: oldText == null ? `Create ${basename(abs)}` : `Edit ${basename(abs)}`,
        detail: abs,
        path: abs,
        toolCall: {
          id: `write_${Date.now()}`,
          title: "write_file",
          kind: "edit",
          status: "pending",
          diffs: [{ path: abs, oldText, newText: p.content }],
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow edits", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });

      if (optionId.includes("reject") || optionId === "cancel") {
        throw new Error("User rejected file write");
      }
      if (
        optionId.includes("always") ||
        optionId.includes("allow_always") ||
        optionId === "proceed_always"
      ) {
        this.autoAllowEdits = true;
        this.emitEvent({
          type: "status",
          message: "File edits will be auto-allowed for this session",
        });
      }
    }

    // Snapshot before write for ghost-git (even when auto-allowed)
    let previous: string | null = null;
    try {
      previous = await readFile(abs, "utf8");
    } catch {
      previous = null;
    }

    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, p.content, "utf8");

    this.ghost.recordWrite(abs, previous, p.content);

    this.emitEvent({
      type: "file_changed",
      path: abs,
      action: "write",
      bytes: Buffer.byteLength(p.content, "utf8"),
    });
    this.emitEvent({
      type: "diff",
      diff: { path: abs, oldText: previous, newText: p.content },
    });
    return null;
  }

  private askLocalPermission(args: {
    title: string;
    detail?: string;
    path?: string;
    toolCall?: ToolCallView;
    options: PermissionOption[];
  }): Promise<string> {
    const requestId = this.nextLocalPermId++;
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        kind: "local",
        waiter: { resolve, reject },
      });
      this.emitEvent({
        type: "permission_request",
        requestId,
        source: "client_fs",
        title: args.title,
        detail: args.detail,
        path: args.path,
        toolCall: args.toolCall,
        options: args.options,
      });
    });
  }

  /** Ensure path is under the project cwd (path jail). */
  private assertInWorkspace(filePath: string): string {
    const abs = resolve(isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath));
    const rel = relative(this.cwd, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      // On Windows, relative can be absolute if different drive
      const cwdLower = this.cwd.toLowerCase();
      const absLower = abs.toLowerCase();
      if (!absLower.startsWith(cwdLower.endsWith(sep) ? cwdLower : cwdLower + sep) && absLower !== cwdLower) {
        throw new Error(`Path outside workspace is blocked: ${abs}`);
      }
    }
    return abs;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error("ACP process not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(msg: JsonRpcMessage) {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function normalizeOptions(options?: PermissionOption[]): PermissionOption[] {
  if (Array.isArray(options) && options.length > 0) {
    return options.map((o) => ({
      optionId: String(o.optionId),
      name: String(o.name ?? o.optionId),
      kind: o.kind != null ? String(o.kind) : undefined,
    }));
  }
  return [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ];
}

function pickAllowOption(options: PermissionOption[], preferAlways: boolean): string {
  if (preferAlways) {
    const always = options.find(
      (o) =>
        o.kind === "allow_always" ||
        o.optionId.includes("always") ||
        o.optionId.includes("proceed_always"),
    );
    if (always) return always.optionId;
  }
  const once = options.find(
    (o) =>
      o.kind === "allow_once" ||
      o.optionId.includes("once") ||
      o.optionId.includes("proceed_once") ||
      o.optionId.includes("allow"),
  );
  return once?.optionId || options[0]?.optionId || "allow-once";
}

function pickRejectOption(options: PermissionOption[]): string {
  const reject = options.find(
    (o) =>
      o.kind === "reject_once" ||
      o.kind === "reject_always" ||
      o.optionId.includes("reject") ||
      o.optionId.includes("cancel"),
  );
  return reject?.optionId || "reject-once";
}

function isMutatingTool(toolCall?: ToolCallView): boolean {
  if (!toolCall) return true;
  const kind = (toolCall.kind || "").toLowerCase();
  if (["edit", "delete", "move", "execute"].includes(kind)) return true;
  const title = `${toolCall.title || ""} ${toolCall.tool || ""}`.toLowerCase();
  return /write|edit|delete|shell|bash|run_terminal|search_replace|apply_patch/.test(title);
}

function summarizeTool(toolCall?: ToolCallView): string | undefined {
  if (!toolCall) return undefined;
  if (toolCall.diffs?.length) {
    return toolCall.diffs.map((d) => d.path).join(", ");
  }
  if (toolCall.input != null) {
    try {
      return typeof toolCall.input === "string"
        ? toolCall.input.slice(0, 400)
        : JSON.stringify(toolCall.input).slice(0, 400);
    } catch {
      return String(toolCall.input).slice(0, 400);
    }
  }
  return undefined;
}

function extractPathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["path", "file_path", "filePath", "target_file"]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  return undefined;
}

function normalizeToolCall(update: Record<string, unknown>): ToolCallView {
  const id = String(update.toolCallId ?? update.id ?? cryptoRandomId());
  const statusRaw = String(update.status ?? "pending").toLowerCase();
  const status: ToolCallView["status"] =
    statusRaw === "completed" ||
    statusRaw === "failed" ||
    statusRaw === "cancelled" ||
    statusRaw === "in_progress"
      ? statusRaw
      : "pending";

  const content = update.content;
  const diffs = extractDiffs(content, update);

  const locations = Array.isArray(update.locations)
    ? (update.locations as Array<Record<string, unknown>>).map((l) => ({
        path: String(l.path ?? ""),
        line: typeof l.line === "number" ? l.line : undefined,
      }))
    : undefined;

  return {
    id,
    title: update.title != null ? String(update.title) : undefined,
    kind: update.kind != null ? String(update.kind) : undefined,
    tool: update.tool != null ? String(update.tool) : update.title != null ? String(update.title) : undefined,
    status,
    input: update.rawInput ?? update.input ?? update.arguments,
    output: update.rawOutput ?? update.output ?? update.result,
    content,
    locations,
    diffs,
  };
}

function extractDiffs(content: unknown, update: Record<string, unknown>): FileDiff[] {
  const diffs: FileDiff[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object" && (item as { type?: string }).type === "diff") {
        const d = item as { path?: string; oldText?: string | null; newText?: string };
        if (d.path && typeof d.newText === "string") {
          diffs.push({ path: d.path, oldText: d.oldText ?? null, newText: d.newText });
        }
      }
    }
  }
  // Sometimes rawInput has path + content for writes
  const raw = (update.rawInput ?? update.input) as Record<string, unknown> | undefined;
  if (diffs.length === 0 && raw && typeof raw === "object") {
    const path = (raw.file_path || raw.path || raw.target_file) as string | undefined;
    const newText = (raw.content || raw.new_string || raw.contents) as string | undefined;
    if (path && typeof newText === "string") {
      diffs.push({ path, oldText: null, newText });
    }
  }
  return diffs;
}

function cryptoRandomId(): string {
  return `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractContextLimit(init: Record<string, unknown>): number | undefined {
  try {
    const meta = init._meta as Record<string, unknown> | undefined;
    const modelState = meta?.modelState as Record<string, unknown> | undefined;
    const models = modelState?.availableModels as Array<Record<string, unknown>> | undefined;
    const first = models?.[0];
    const mmeta = first?._meta as Record<string, unknown> | undefined;
    const n = mmeta?.totalContextTokens;
    if (typeof n === "number" && n > 0) return n;
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractUsage(meta: unknown, contextLimit: number): TokenUsage | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const u = (m.usage && typeof m.usage === "object" ? m.usage : m) as Record<string, unknown>;
  const total =
    num(u.totalTokens) ??
    num(u.total_tokens) ??
    num(m.totalTokens) ??
    num(m.total_tokens);
  const input = num(u.inputTokens) ?? num(u.input_tokens) ?? num(m.inputTokens);
  const output = num(u.outputTokens) ?? num(u.output_tokens) ?? num(m.outputTokens);
  const cached = num(u.cachedReadTokens) ?? num(u.cached_read_tokens) ?? num(m.cachedReadTokens);
  const reasoning = num(u.reasoningTokens) ?? num(u.reasoning_tokens);
  if (total == null && input == null && output == null) return null;
  return {
    totalTokens: total ?? (input != null || output != null ? (input || 0) + (output || 0) : undefined),
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: cached,
    reasoningTokens: reasoning,
    contextLimit,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export type { StreamEvent };
