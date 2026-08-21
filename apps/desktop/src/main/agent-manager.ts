import type { BrowserWindow } from "electron";
import { GrokAcpClient, GhostGit } from "@grok-deck/acp-client";
import {
  IpcChannels,
  type AgentRuntimeStatus,
  type AgentThreadInfo,
  type AppSettings,
  type DeckMode,
  type GhostStatus,
  type StreamEvent,
} from "@grok-deck/shared";

type Parked = {
  client: GrokAcpClient;
  cwd: string;
  sessionId: string;
  mode: DeckMode;
  status: AgentRuntimeStatus;
  promptChain: Promise<void>;
};

function slotKey(cwd: string, sessionId: string): string {
  return `${normalizeCwd(cwd)}::${sessionId}`;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export class AgentManager {
  private client: GrokAcpClient | null = null;
  private status: AgentRuntimeStatus = { state: "idle" };
  private promptChain: Promise<void> = Promise.resolve();
  private cwd = "";
  private mode: DeckMode = "normal";
  private parked = new Map<string, Parked>();

  constructor(private getWindow: () => BrowserWindow | null) {}

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getMode(): DeckMode {
    return this.client?.getMode() ?? this.mode;
  }

  listThreads(): AgentThreadInfo[] {
    const out: AgentThreadInfo[] = [];
    if (this.client) {
      const sid = this.client.getSessionId();
      if (sid) {
        out.push({
          cwd: this.cwd,
          sessionId: sid,
          state: this.status.state,
        });
      }
    }
    for (const p of this.parked.values()) {
      out.push({
        cwd: p.cwd,
        sessionId: p.sessionId,
        state: p.status.state,
      });
    }
    return out;
  }

  private emitThreads() {
    this.getWindow()?.webContents.send(IpcChannels.agentThreads, this.listThreads());
  }

  private setStatus(status: AgentRuntimeStatus) {
    this.status = status;
    this.getWindow()?.webContents.send(IpcChannels.agentStatus, status);
    this.emitThreads();
  }

  private sendEvent(event: StreamEvent, meta?: { sessionId?: string; cwd?: string }) {
    const sessionId = meta?.sessionId || this.client?.getSessionId() || undefined;
    const cwd = meta?.cwd || this.cwd || undefined;
    this.getWindow()?.webContents.send(IpcChannels.agentEvent, {
      ...event,
      sessionId,
      cwd,
    });
  }

  private attachClient(client: GrokAcpClient, cwd: string) {
    client.on("event", (event: StreamEvent) => {
      if (event.type === "mode") this.mode = event.mode;
      const sid = client.getSessionId() || undefined;
      this.sendEvent(event, { sessionId: sid, cwd });
      if (event.type === "turn_done" || event.type === "error") {
        const key = sid ? slotKey(cwd, sid) : "";
        const parked = key ? this.parked.get(key) : undefined;
        if (parked) {
          parked.status = {
            state: event.type === "error" ? "error" : "ready",
            ...(event.type === "error"
              ? { message: (event as { message: string }).message }
              : { sessionId: sid || parked.sessionId, cwd, mode: parked.mode }),
          } as AgentRuntimeStatus;
        } else if (this.client === client && sid) {
          this.setStatus({
            state: event.type === "error" ? "error" : "ready",
            ...(event.type === "error"
              ? { message: (event as { message: string }).message }
              : { sessionId: sid, cwd, mode: this.mode }),
          } as AgentRuntimeStatus);
        }
        this.emitThreads();
      }
    });
    client.on("stderr", (text: string) => {
      if (text.includes("failed to decode") && text.includes("Method not found")) return;
      this.sendEvent({ type: "status", message: text }, { sessionId: client.getSessionId() || undefined, cwd });
    });
    client.on("error", (err: Error) => {
      this.sendEvent({ type: "error", message: err.message }, { sessionId: client.getSessionId() || undefined, cwd });
      if (this.client === client) this.setStatus({ state: "error", message: err.message });
      this.emitThreads();
    });
    client.on("exit", ({ code }: { code: number | null }) => {
      const sid = client.getSessionId();
      if (sid) this.parked.delete(slotKey(cwd, sid));
      if (this.client === client) {
        this.client = null;
        this.setStatus({
          state: "error",
          message: `Agent process exited (code ${code ?? "?"})`,
        });
      }
      this.emitThreads();
    });
  }

  /** Keep a running session alive when the UI switches away. */
  private parkFocused() {
    if (!this.client) return;
    const sid = this.client.getSessionId();
    if (!sid) {
      const c = this.client;
      this.client = null;
      void c.stop().catch(() => undefined);
      return;
    }
    const key = slotKey(this.cwd, sid);
    this.parked.set(key, {
      client: this.client,
      cwd: this.cwd,
      sessionId: sid,
      mode: this.mode,
      status: this.status,
      promptChain: this.promptChain,
    });
    this.client = null;
    this.promptChain = Promise.resolve();
    this.emitThreads();
  }

  private promote(key: string): boolean {
    const p = this.parked.get(key);
    if (!p) return false;
    this.parkFocused();
    this.parked.delete(key);
    this.client = p.client;
    this.cwd = p.cwd;
    this.mode = p.mode;
    this.status = p.status;
    this.promptChain = p.promptChain;
    this.getWindow()?.webContents.send(IpcChannels.agentStatus, this.status);
    this.emitThreads();
    return true;
  }

  async start(cwd: string, settings: AppSettings): Promise<AgentRuntimeStatus> {
    this.parkFocused();

    this.mode = settings.deckMode ?? "normal";
    this.setStatus({ state: "starting" });
    const client = new GrokAcpClient({
      cwd,
      grokPath: settings.grokPath || "grok",
      model: settings.model,
      mode: this.mode,
      reasoningEffort: settings.reasoningEffort || "high",
    });
    this.attachClient(client, cwd);

    try {
      const { sessionId } = await client.start();
      this.client = client;
      this.cwd = cwd;
      this.mode = client.getMode();
      this.setStatus({ state: "ready", sessionId, cwd, mode: this.mode });
      return this.status;
    } catch (err) {
      await client.stop().catch(() => undefined);
      this.client = null;
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "error", message });
      this.sendEvent({ type: "error", message });
      return this.status;
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      const c = this.client;
      this.client = null;
      await c.stop().catch(() => undefined);
    }
    this.setStatus({ state: "idle" });
  }

  async prompt(
    text: string,
    content?: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Agent is not running. Open a project first.");
    }

    this.promptChain = this.promptChain.then(async () => {
      const sessionId = this.client?.getSessionId();
      if (!sessionId || !this.client) {
        throw new Error("Agent session not ready");
      }
      this.setStatus({ state: "running", sessionId, mode: this.mode });
      try {
        await this.client.prompt(text, content);
        if (this.client) {
          this.mode = this.client.getMode();
          this.setStatus({ state: "ready", sessionId, cwd: this.cwd, mode: this.mode });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.sendEvent({ type: "error", message });
        if (this.client) {
          this.setStatus({
            state: "ready",
            sessionId,
            cwd: this.cwd,
            mode: this.mode,
          });
        }
        throw err;
      }
    });

    return this.promptChain;
  }

  async cancel(): Promise<void> {
    await this.client?.cancel();
  }

  async respondPermission(requestId: number, optionId: string): Promise<void> {
    await this.client?.respondPermission(requestId, optionId);
  }

  async setMode(mode: DeckMode): Promise<DeckMode> {
    this.mode = mode;
    if (this.client) {
      this.mode = await this.client.setMode(mode);
      const sessionId = this.client.getSessionId();
      if (sessionId && (this.status.state === "ready" || this.status.state === "running")) {
        this.setStatus({
          ...this.status,
          mode: this.mode,
        } as AgentRuntimeStatus);
      }
    }
    return this.mode;
  }

  async undoGhost(): Promise<{ ok: boolean; message: string }> {
    if (this.client) {
      return this.client.undoGhost();
    }
    // Agent stopped — still allow undo from disk-backed Ghost Git for this project
    if (!this.cwd) {
      return { ok: false, message: "프로젝트를 먼저 열어주세요" };
    }
    const ghost = new GhostGit(this.cwd);
    const result = await ghost.undoIncludingPending();
    if (result.ok && result.commit) {
      this.sendEvent({
        type: "ghost_undo",
        commit: {
          id: result.commit.id,
          createdAt: result.commit.createdAt,
          message: result.commit.message,
          fileCount: result.commit.changes.length,
          paths: result.commit.changes.map((c) => c.path),
          files: result.commit.changes.map((c) => ({
            path: c.path,
            add: c.add ?? 0,
            del: c.del ?? 0,
          })),
        },
      });
      this.sendEvent({ type: "ghost_status", ghost: await ghost.status() });
    }
    this.sendEvent({ type: "status", message: result.message });
    return { ok: result.ok, message: result.message };
  }

  async ghostStatus(): Promise<GhostStatus> {
    if (this.client) return this.client.ghostStatus();
    if (this.cwd) {
      const ghost = new GhostGit(this.cwd);
      return ghost.status();
    }
    return { canUndo: false, depth: 0 };
  }

  getCommands() {
    return this.client?.getCommands() ?? [];
  }

  getLastPlan() {
    return this.client?.getLastPlan() ?? null;
  }

  /**
   * Apply reasoning effort by restarting the agent process in the same cwd.
   * Grok agent picks effort via --reasoning-effort at start.
   */
  async applySettingsAndRestart(settings: AppSettings): Promise<AgentRuntimeStatus> {
    if (!this.cwd) {
      return { state: "error", message: "No project open" };
    }
    return this.start(this.cwd, settings);
  }

  /**
   * Open project agent and try to resume a historical Grok session.
   * UI history is loaded separately from disk; this restores agent context when possible.
   */
  async loadSession(
    cwd: string,
    sessionId: string,
    settings: AppSettings,
  ): Promise<AgentRuntimeStatus> {
    const key = slotKey(cwd, sessionId);
    const focusedSid = this.client?.getSessionId();
    if (focusedSid && this.cwd && slotKey(this.cwd, focusedSid) === key) {
      return this.status;
    }
    if (this.promote(key)) {
      return this.status;
    }

    this.parkFocused();
    this.mode = settings.deckMode ?? "normal";
    this.setStatus({ state: "starting" });

    const client = new GrokAcpClient({
      cwd,
      grokPath: settings.grokPath || "grok",
      model: settings.model,
      mode: this.mode,
      reasoningEffort: settings.reasoningEffort || "high",
    });
    this.attachClient(client, cwd);

    try {
      const { sessionId: sid, loaded } = await client.loadSession(sessionId);
      if (!loaded || sid !== sessionId) {
        await client.stop().catch(() => undefined);
        this.client = null;
        const message = "기존 스레드를 열지 못해 새 방으로 바꾸지 않았습니다";
        this.setStatus({ state: "error", message });
        this.sendEvent({ type: "error", message });
        return this.status;
      }
      this.client = client;
      this.cwd = cwd;
      this.mode = client.getMode();
      this.setStatus({ state: "ready", sessionId: sid, cwd, mode: this.mode });
      return this.status;
    } catch (err) {
      await client.stop().catch(() => undefined);
      this.client = null;
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ state: "error", message });
      this.sendEvent({ type: "error", message });
      return this.status;
    }
  }
}
