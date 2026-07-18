import type { BrowserWindow } from "electron";
import { GrokAcpClient, GhostGit } from "@grok-deck/acp-client";
import {
  IpcChannels,
  type AgentRuntimeStatus,
  type AppSettings,
  type DeckMode,
  type GhostStatus,
  type StreamEvent,
} from "@grok-deck/shared";

export class AgentManager {
  private client: GrokAcpClient | null = null;
  private status: AgentRuntimeStatus = { state: "idle" };
  private promptChain: Promise<void> = Promise.resolve();
  private cwd = "";
  private mode: DeckMode = "normal";

  constructor(private getWindow: () => BrowserWindow | null) {}

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  getMode(): DeckMode {
    return this.client?.getMode() ?? this.mode;
  }

  private setStatus(status: AgentRuntimeStatus) {
    this.status = status;
    this.getWindow()?.webContents.send(IpcChannels.agentStatus, status);
  }

  private sendEvent(event: StreamEvent) {
    this.getWindow()?.webContents.send(IpcChannels.agentEvent, event);
  }

  async start(cwd: string, settings: AppSettings): Promise<AgentRuntimeStatus> {
    await this.stop();

    this.mode = settings.deckMode ?? "normal";
    this.setStatus({ state: "starting" });
    const client = new GrokAcpClient({
      cwd,
      grokPath: settings.grokPath || "grok",
      model: settings.model,
      mode: this.mode,
      reasoningEffort: settings.reasoningEffort || "high",
    });

    client.on("event", (event: StreamEvent) => {
      if (event.type === "mode") this.mode = event.mode;
      this.sendEvent(event);
    });
    client.on("stderr", (text: string) => {
      // Filter noisy decode errors
      if (text.includes("failed to decode") && text.includes("Method not found")) return;
      this.sendEvent({ type: "status", message: text });
    });
    client.on("error", (err: Error) => {
      this.sendEvent({ type: "error", message: err.message });
      this.setStatus({ state: "error", message: err.message });
    });
    client.on("exit", ({ code }: { code: number | null }) => {
      if (this.client === client) {
        this.client = null;
        this.setStatus({
          state: "error",
          message: `Agent process exited (code ${code ?? "?"})`,
        });
      }
    });

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
    await this.stop();
    this.mode = settings.deckMode ?? "normal";
    this.setStatus({ state: "starting" });

    const client = new GrokAcpClient({
      cwd,
      grokPath: settings.grokPath || "grok",
      model: settings.model,
      mode: this.mode,
      reasoningEffort: settings.reasoningEffort || "high",
    });

    client.on("event", (event: StreamEvent) => {
      if (event.type === "mode") this.mode = event.mode;
      this.sendEvent(event);
    });
    client.on("stderr", (text: string) => {
      if (text.includes("failed to decode") && text.includes("Method not found")) return;
      this.sendEvent({ type: "status", message: text });
    });
    client.on("error", (err: Error) => {
      this.sendEvent({ type: "error", message: err.message });
      this.setStatus({ state: "error", message: err.message });
    });
    client.on("exit", ({ code }: { code: number | null }) => {
      if (this.client === client) {
        this.client = null;
        this.setStatus({
          state: "error",
          message: `Agent process exited (code ${code ?? "?"})`,
        });
      }
    });

    try {
      const { sessionId: sid } = await client.loadSession(sessionId);
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
