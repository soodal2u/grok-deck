import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  IpcChannels,
  type AgentRuntimeStatus,
  type AppSettings,
  type AuthStatus,
  type ChatAttachment,
  type ChatMessage,
  type DeckMode,
  type GhostStatus,
  type PlanDocument,
  type OpenExternalTarget,
  type ProjectGroup,
  type ProjectState,
  type PromptRequest,
  type CustomThemeInfo,
  type ReasoningEffort,
  type SkillInfo,
  type SlashCommand,
  type StreamEvent,
  type ThreadSnapshot,
  type WorkspaceFileEntry,
  type AgentThreadInfo,
  type QueuedMessage,
} from "@grok-deck/shared";

const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannels.appGetVersion),
    notify: (payload: {
      title?: string;
      body?: string;
      silent?: boolean;
      force?: boolean;
    }): Promise<{ ok: boolean; skipped?: string }> =>
      ipcRenderer.invoke(IpcChannels.appNotify, payload),
  },
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IpcChannels.authGetStatus),
    login: (): Promise<{ ok: boolean; message?: string; status: AuthStatus }> =>
      ipcRenderer.invoke(IpcChannels.authLogin),
    logout: (): Promise<AuthStatus> => ipcRenderer.invoke(IpcChannels.authLogout),
  },
  project: {
    get: (): Promise<ProjectState> => ipcRenderer.invoke(IpcChannels.projectGet),
    open: (): Promise<ProjectState> => ipcRenderer.invoke(IpcChannels.projectOpen),
    create: (
      name: string,
    ): Promise<{
      ok: boolean;
      cwd?: string;
      message: string;
      project?: ProjectState;
    }> => ipcRenderer.invoke(IpcChannels.projectCreate, name),
    openExternal: (
      target: OpenExternalTarget,
      cwd?: string,
    ): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IpcChannels.projectOpenExternal, target, cwd),
  },
  shell: {
    openPath: (
      pathOrUrl: string,
      projectRoot?: string,
    ): Promise<{ ok: boolean; message?: string; resolved?: string }> =>
      ipcRenderer.invoke(IpcChannels.shellOpenPath, pathOrUrl, projectRoot),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IpcChannels.settingsGet),
    set: (settings: AppSettings): Promise<AppSettings> =>
      ipcRenderer.invoke(IpcChannels.settingsSet, settings),
  },
  sessions: {
    list: (includeNoise?: boolean): Promise<ProjectGroup[]> =>
      ipcRenderer.invoke(IpcChannels.sessionsList, includeNoise),
    transcript: (
      sessionId: string,
      cwd: string,
    ): Promise<{ messages: ChatMessage[]; queue: QueuedMessage[]; snapshotAt: number } | ChatMessage[]> =>
      ipcRenderer.invoke(IpcChannels.sessionsTranscript, sessionId, cwd),
    delete: (
      sessionId: string,
      cwd: string,
    ): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannels.sessionsDelete, sessionId, cwd),
  },
  agent: {
    start: (cwd?: string): Promise<AgentRuntimeStatus> =>
      ipcRenderer.invoke(IpcChannels.agentStart, cwd),
    stop: (): Promise<AgentRuntimeStatus> => ipcRenderer.invoke(IpcChannels.agentStop),
    loadSession: (cwd: string, sessionId: string): Promise<AgentRuntimeStatus> =>
      ipcRenderer.invoke(IpcChannels.agentLoadSession, cwd, sessionId),
    prompt: (req: string | PromptRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IpcChannels.agentPrompt, req),
    cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IpcChannels.agentCancel),
    respondPermission: (requestId: number, optionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IpcChannels.agentRespondPermission, requestId, optionId),
    setMode: (mode: DeckMode): Promise<DeckMode> =>
      ipcRenderer.invoke(IpcChannels.agentSetMode, mode),
    getMode: (): Promise<DeckMode> => ipcRenderer.invoke(IpcChannels.agentGetMode),
    setEffort: (effort: ReasoningEffort): Promise<ReasoningEffort> =>
      ipcRenderer.invoke(IpcChannels.agentSetEffort, effort),
    getCommands: (): Promise<SlashCommand[]> =>
      ipcRenderer.invoke(IpcChannels.agentGetCommands),
    getPlan: (): Promise<PlanDocument | null> =>
      ipcRenderer.invoke(IpcChannels.agentGetPlan),
    getStatus: (): Promise<AgentRuntimeStatus> => ipcRenderer.invoke(IpcChannels.agentStatus),
    onEvent: (handler: (event: StreamEvent) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: StreamEvent) => handler(event);
      ipcRenderer.on(IpcChannels.agentEvent, listener);
      return () => ipcRenderer.removeListener(IpcChannels.agentEvent, listener);
    },
    onStatus: (handler: (status: AgentRuntimeStatus) => void) => {
      const listener = (_: Electron.IpcRendererEvent, status: AgentRuntimeStatus) =>
        handler(status);
      ipcRenderer.on(IpcChannels.agentStatus, listener);
      return () => ipcRenderer.removeListener(IpcChannels.agentStatus, listener);
    },
    onThreads: (handler: (threads: AgentThreadInfo[]) => void) => {
      const listener = (_: Electron.IpcRendererEvent, threads: AgentThreadInfo[]) =>
        handler(threads);
      ipcRenderer.on(IpcChannels.agentThreads, listener);
      return () => ipcRenderer.removeListener(IpcChannels.agentThreads, listener);
    },
  },
  threads: {
    get: (sessionId: string, cwd: string): Promise<ThreadSnapshot | null> =>
      ipcRenderer.invoke(IpcChannels.threadGet, sessionId, cwd),
    set: (snap: ThreadSnapshot): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IpcChannels.threadSet, snap),
  },
  ghost: {
    undo: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannels.ghostUndo),
    status: (): Promise<GhostStatus> => ipcRenderer.invoke(IpcChannels.ghostStatus),
  },
  attachments: {
    pick: (): Promise<{ ok: boolean; attachments: ChatAttachment[]; message?: string }> =>
      ipcRenderer.invoke(IpcChannels.attachmentsPick),
    fromPaths: (paths: string[]): Promise<ChatAttachment[]> =>
      ipcRenderer.invoke(IpcChannels.attachmentsFromPaths, paths),
    fromClipboardImage: (
      payload: { mimeType: string; data: string; name?: string },
    ): Promise<ChatAttachment | { error: string } | null> =>
      ipcRenderer.invoke(IpcChannels.attachmentsFromData, payload),
    /** Resolve local path for a drag/drop or paste File (Electron 32+) */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) || "";
      } catch {
        const legacy = file as File & { path?: string };
        return legacy.path || "";
      }
    },
  },
  skills: {
    list: (cwd?: string): Promise<SkillInfo[]> =>
      ipcRenderer.invoke(IpcChannels.skillsList, cwd),
  },
  workspace: {
    searchFiles: (query?: string, cwd?: string): Promise<WorkspaceFileEntry[]> =>
      ipcRenderer.invoke(IpcChannels.workspaceSearchFiles, query, cwd),
  },
  themes: {
    list: (): Promise<{ themes: CustomThemeInfo[] }> =>
      ipcRenderer.invoke(IpcChannels.themesList),
    dataUrl: (themeId: string): Promise<string | null> =>
      ipcRenderer.invoke(IpcChannels.themesDataUrl, themeId),
    recent: (): Promise<Array<{ path: string; mtimeMs: number; size: number }>> =>
      ipcRenderer.invoke(IpcChannels.themesRecent),
    importFile: (): Promise<{ ok: boolean; theme?: CustomThemeInfo; message: string }> =>
      ipcRenderer.invoke(IpcChannels.themesImportFile),
    importPath: (
      filePath: string,
      label?: string,
    ): Promise<{ ok: boolean; theme?: CustomThemeInfo; message: string }> =>
      ipcRenderer.invoke(IpcChannels.themesImportPath, filePath, label),
    importLatest: (opts?: {
      sinceMs?: number;
      label?: string;
      prompt?: string;
    }): Promise<{ ok: boolean; theme?: CustomThemeInfo; message: string; path?: string }> =>
      ipcRenderer.invoke(IpcChannels.themesImportLatest, opts),
    delete: (id: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IpcChannels.themesDelete, id),
    generate: (
      prompt: string,
    ): Promise<{
      ok: boolean;
      message: string;
      theme?: CustomThemeInfo;
      settings?: AppSettings;
    }> => ipcRenderer.invoke(IpcChannels.themesGenerate, prompt),
  },
  window: {
    resizeStart: (edge: string, screenX: number, screenY: number) => {
      ipcRenderer.send("window:resize-start", { edge, screenX, screenY });
    },
    resizeMove: (screenX: number, screenY: number) => {
      ipcRenderer.send("window:resize-move", { screenX, screenY });
    },
    resizeEnd: () => {
      ipcRenderer.send("window:resize-end");
    },
  },
};

contextBridge.exposeInMainWorld("grokDeck", api);

export type GrokDeckApi = typeof api;
