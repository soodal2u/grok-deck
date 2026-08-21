import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AgentRuntimeStatus,
  AppSettings,
  AuthStatus,
  ChatAttachment,
  ChatMessage,
  DeckMode,
  FileDiff,
  PermissionOption,
  PlanDocument,
  ProjectGroup,
  ProjectState,
  SessionSummary,
  StreamEvent,
  ToolCallView,
  QueuedMessage,
  AgentThreadInfo,
} from "@grok-deck/shared";
import {
  BUILTIN_SLASH,
  DEFAULT_SETTINGS,
  PANEL_LIMITS,
  REASONING_EFFORTS,
  THEMES,
  deckModeHint,
  deckModeLabel,
  formatDuration,
  isEditTool,
  nextDeckMode,
  type CustomThemeInfo,
  type GhostStatus,
  type ReasoningEffort,
  type SlashCommand,
  type ThemeId,
  type TokenUsage,
  customThemeKey,
  isCustomThemeId,
} from "@grok-deck/shared";
import { closeOpenFences } from "./path-links";
import { playDoneChime } from "./done-chime";
import { Markdown } from "./components/Markdown";
import { ToolChip, ToolGroup } from "./components/ToolChip";
import { EditSummaryCard } from "./components/EditSummaryCard";
import { PlanReviewCard } from "./components/PlanReviewCard";
import { LiveToolToast } from "./components/LiveToolToast";
import { PlanStepsPanel } from "./components/PlanStepsPanel";
import { ContextMeter } from "./components/ContextMeter";
import { ResizeHandles } from "./components/ResizeHandles";
import { PanelDivider } from "./components/PanelDivider";
import { Composer } from "./components/Composer";
import { QueueBar } from "./components/QueueBar";

function emitDeckStatus(msg: string) {
  window.dispatchEvent(new CustomEvent("deck-status", { detail: msg }));
}

function uid(prefix = "m") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function payloadChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function estimateMessageTokens(m: ChatMessage): number {
  let chars = (m.content?.length || 0) + (m.thoughts?.length || 0);
  for (const t of m.toolCalls || []) {
    chars += (t.title?.length || 0) + payloadChars(t.input) + payloadChars(t.output) + payloadChars(t.content);
  }
  return Math.round(chars / 4);
}

function estimateTranscriptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

function threadKey(cwd: string, sessionId: string): string {
  return `${cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}::${sessionId}`;
}

function officialUsed(u: TokenUsage | null | undefined): number | null {
  if (!u) return null;
  if (u.totalTokens != null) return u.totalTokens;
  if (u.inputTokens != null || u.outputTokens != null) {
    return (u.inputTokens || 0) + (u.outputTokens || 0);
  }
  return null;
}

function shortPath(p: string | null | undefined) {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function fileName(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function relativeDiffStats(diff: FileDiff): { add: number; del: number } {
  const oldN = (diff.oldText ?? "").split(/\r?\n/).length;
  const newN = diff.newText.split(/\r?\n/).length;
  if (!diff.oldText) return { add: newN, del: 0 };
  return {
    add: Math.max(0, newN - Math.min(oldN, newN)),
    del: Math.max(0, oldN - Math.min(oldN, newN)),
  };
}

/** Build per-file edit stats from tool diffs (fallback when Ghost commit is late/missing). */
function editFilesFromTools(
  tools?: ToolCallView[],
): Array<{ path: string; add: number; del: number }> {
  if (!tools?.length) return [];
  const map = new Map<string, { path: string; add: number; del: number }>();
  for (const t of tools) {
    if (!isEditTool(t)) continue;
    if (t.diffs?.length) {
      for (const d of t.diffs) {
        const s = relativeDiffStats(d);
        const prev = map.get(d.path);
        if (prev) {
          prev.add += s.add;
          prev.del += s.del;
        } else map.set(d.path, { path: d.path, add: s.add, del: s.del });
      }
    } else {
      const loc = t.locations?.[0]?.path;
      const title = t.title || t.tool || "";
      const m = title.match(/[`'"]([^`'"]+)[`'"]/);
      const path = loc || m?.[1];
      if (path && !map.has(path)) map.set(path, { path, add: 0, del: 0 });
    }
  }
  return [...map.values()];
}

function mergeEditFiles(
  a: Array<{ path: string; add: number; del: number }>,
  b: Array<{ path: string; add: number; del: number }>,
): Array<{ path: string; add: number; del: number }> {
  const map = new Map<string, { path: string; add: number; del: number }>();
  for (const f of [...a, ...b]) {
    const prev = map.get(f.path);
    if (prev) {
      prev.add = Math.max(prev.add, f.add);
      prev.del = Math.max(prev.del, f.del);
    } else map.set(f.path, { ...f });
  }
  return [...map.values()];
}

function unifiedDiffPreview(diff: FileDiff, maxLines = 48): string {
  const oldLines = (diff.oldText ?? "").split(/\r?\n/);
  const newLines = diff.newText.split(/\r?\n/);
  if (!diff.oldText) {
    return newLines
      .slice(0, maxLines)
      .map((l) => `+ ${l}`)
      .join("\n");
  }
  const out: string[] = [];
  const n = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < n && out.length < maxLines; i++) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) {
      if (a != null) out.push(`  ${a}`);
    } else {
      if (a != null) out.push(`- ${a}`);
      if (b != null) out.push(`+ ${b}`);
    }
  }
  if (n > maxLines) out.push("…");
  return out.join("\n");
}

type PermissionState = {
  requestId: number;
  source: string;
  title: string;
  detail?: string;
  path?: string;
  toolCall?: ToolCallView;
  options: PermissionOption[];
};

export function App() {
  const [auth, setAuth] = useState<AuthStatus>({ state: "unknown" });
  const [project, setProject] = useState<ProjectState>({ root: null, recent: [] });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [agentStatus, setAgentStatus] = useState<AgentRuntimeStatus>({ state: "idle" });
  const [mode, setMode] = useState<DeckMode>("normal");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [statusLine, setStatusLine] = useState("Ready");
  const [permissionQueue, setPermissionQueue] = useState<PermissionState[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [changedFiles, setChangedFiles] = useState<Map<string, FileDiff>>(new Map());
  const [selectedDiff, setSelectedDiff] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectGroup[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const [ghost, setGhost] = useState<GhostStatus>({ canUndo: false, depth: 0 });
  const [undoing, setUndoing] = useState(false);
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>(BUILTIN_SLASH);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [showNoiseSessions, setShowNoiseSessions] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "theme" | "ai">("general");
  const [aiThemePrompt, setAiThemePrompt] = useState(
    "calm dark coding wallpaper, subtle orange ambient light, no text, no UI, abstract",
  );
  const [customThemes, setCustomThemes] = useState<CustomThemeInfo[]>([]);
  const [themeBusy, setThemeBusy] = useState(false);
  const [recentImages, setRecentImages] = useState<
    Array<{ path: string; mtimeMs: number; size: number }>
  >([]);
  /** Resolved wallpaper (data URL for custom themes — reliable display) */
  const [wallpaperSrc, setWallpaperSrc] = useState<string | null>(null);
  /** Codex-style plan review (from plan.md / ACP plan updates) */
  const [activePlan, setActivePlan] = useState<PlanDocument | null>(null);
  const [planDismissed, setPlanDismissed] = useState(false);
  /** State mirror of streaming message id — ref alone does not trigger re-render for `live` */
  const [liveMessageId, setLiveMessageId] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [compact, setCompact] = useState<{
    status: "idle" | "started" | "done" | "failed";
    before?: number;
    after?: number;
    at?: number;
    message?: string;
  }>({ status: "idle" });
  const [draftSeed, setDraftSeed] = useState(0);
  const [draftSeedText, setDraftSeedText] = useState("");
  const [dragCwd, setDragCwd] = useState<string | null>(null);
  const [overCwd, setOverCwd] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [agentThreads, setAgentThreads] = useState<AgentThreadInfo[]>([]);

  const chatRef = useRef<HTMLDivElement>(null);
  const chatInnerRef = useRef<HTMLDivElement>(null);
  const streamingId = useRef<string | null>(null);
  const turnStartRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const ignoreScrollRef = useRef(false);
  const cancelTimerRef = useRef<number | null>(null);
  const usageRef = useRef<TokenUsage | null>(null);
  const usageBaselineRef = useRef<number | null>(null);
  const selectingRef = useRef(false);
  const activeKeyRef = useRef("");
  const cacheRef = useRef<
    Record<
      string,
      {
        sessionId: string;
        cwd: string;
        messages: ChatMessage[];
        queue: QueuedMessage[];
        busy: boolean;
        liveMessageId: string | null;
      }
    >
  >({});
  const persistTimers = useRef<Record<string, number>>({});
  const streamingByKey = useRef<Record<string, string | null>>({});
  const messagesRef = useRef<ChatMessage[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const busyRef = useRef(false);
  const liveIdRef = useRef<string | null>(null);
  const sessionRef = useRef<SessionSummary | null>(null);
  const projectRef = useRef<ProjectState>({ root: null, recent: [] });
  const settingsRef = useRef<AppSettings>(settings);
  const submitRef = useRef<(text: string, atts: ChatAttachment[]) => void>(() => undefined);

  const scrollChatToBottom = useCallback((force = false) => {
    const el = chatRef.current;
    if (!el) return;
    if (selectingRef.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) return;
    if (!force && !stickToBottomRef.current) return;
    ignoreScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
        ignoreScrollRef.current = false;
      });
    });
  }, []);

  const permission = permissionQueue[0] ?? null;

  const refreshSessions = useCallback(async () => {
    const list = await window.grokDeck.sessions.list(showNoiseSessions);
    setProjects(list);
    setExpanded((prev) => {
      const persisted = settings.sidebarExpanded || {};
      const next = { ...persisted, ...prev };
      return next;
    });
  }, [showNoiseSessions, settings.sidebarExpanded]);

  const refresh = useCallback(async () => {
    const [a, p, s, st, m, cat] = await Promise.all([
      window.grokDeck.auth.getStatus(),
      window.grokDeck.project.get(),
      window.grokDeck.settings.get(),
      window.grokDeck.agent.getStatus(),
      window.grokDeck.agent.getMode(),
      window.grokDeck.themes.list().catch(() => ({ themes: [] as CustomThemeInfo[] })),
    ]);
    setAuth(a);
    setProject(p);
    setSettings(s);
    setAgentStatus(st);
    setMode(m || s.deckMode || "normal");
    setCustomThemes(cat.themes || []);
    if (s.sidebarExpanded) {
      setExpanded((prev) => ({ ...prev, ...s.sidebarExpanded }));
    }
    await refreshSessions();
    try {
      setGhost(await window.grokDeck.ghost.status());
    } catch {
      /* ignore */
    }
  }, [refreshSessions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void window.grokDeck.app.getVersion().then((v) => {
      setAppVersion(v);
      document.title = v ? `Grok Deck ${v}` : "Grok Deck";
    });
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [showNoiseSessions, refreshSessions]);

  useEffect(() => {
    document.documentElement.dataset.theme = isCustomThemeId(settings.theme)
      ? "custom"
      : settings.theme;
  }, [settings.theme]);

  // Re-resolve wallpaper when theme/catalog changes (custom themes need data URL)
  useEffect(() => {
    void resolveWallpaper(settings, customThemes);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on theme identity
  }, [settings.theme, settings.customThemeId, customThemes]);

  useEffect(() => {
    const onStatus = (e: Event) => {
      const msg = (e as CustomEvent<string>).detail;
      if (msg) setStatusLine(msg);
    };
    window.addEventListener("deck-status", onStatus);
    return () => window.removeEventListener("deck-status", onStatus);
  }, []);

  useEffect(() => {
    if (showSettings && (settingsTab === "theme" || settingsTab === "ai")) {
      void refreshCustomThemes();
      void refreshRecentImages();
    }
  }, [showSettings, settingsTab]);

  useEffect(() => {
    const offEvent = window.grokDeck.agent.onEvent((event) => handleStreamEvent(event));
    const offThreads = window.grokDeck.agent.onThreads((threads) => setAgentThreads(threads));
    const offStatus = window.grokDeck.agent.onStatus((status) => {
      setAgentStatus(status);
      if ("mode" in status && status.mode) setMode(status.mode);
      if (status.state === "ready") {
        setStatusLine(`Ready · ${shortPath(status.cwd)}`);
        if (!sessionRef.current?.id && "sessionId" in status && status.sessionId) {
          adoptSession({
            id: status.sessionId,
            cwd: status.cwd,
            title: "새 세션",
          });
        }
        void window.grokDeck.ghost.status().then(setGhost);
      }
      if (status.state === "running") setStatusLine("Working…");
      if (status.state === "error") setStatusLine(status.message);
      if (status.state === "idle") setStatusLine("Idle");
      if (status.state === "starting") setStatusLine("Starting…");
    });
    const onHide = () => {
      const s = sessionRef.current;
      const root = s?.cwd || projectRef.current.root;
      if (!s?.id || !root) return;
      void window.grokDeck.threads.set({
        sessionId: s.id,
        cwd: root,
        messages: messagesRef.current,
        queue: queueRef.current,
        updatedAt: Date.now(),
      });
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    return () => {
      offEvent();
      offStatus();
      offThreads();
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
    };
  }, []);

  useEffect(() => {
    scrollChatToBottom();
  }, [messages, permissionQueue, loadingHistory, liveMessageId, scrollChatToBottom]);

  // After a thread finishes loading, pin to the latest message (markdown/images settle late)
  useEffect(() => {
    if (loadingHistory || messages.length === 0) return;
    stickToBottomRef.current = true;
    scrollChatToBottom(true);
    const timers = [50, 180, 400, 900].map((ms) =>
      window.setTimeout(() => scrollChatToBottom(true), ms),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
    // Only re-run when the open thread or load flag changes — not every streamed token
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingHistory, activeSession?.id]);

  useEffect(() => {
    const inner = chatInnerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollChatToBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [scrollChatToBottom, loadingHistory, messages.length > 0]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        void cycleMode();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void applyMode(mode === "yolo" ? "normal" : "yolo");
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewProjectOpen(true);
      }
      if (e.key === "Escape" && busy) {
        e.preventDefault();
        void onCancelTurn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, project.root, busy]);

  function activeThreadKey(): string {
    const s = sessionRef.current;
    const root = s?.cwd || projectRef.current.root;
    if (s?.id && root) return threadKey(root, s.id);
    return activeKeyRef.current;
  }

  function adoptSession(session: SessionSummary | null) {
    setActiveSession(session);
    sessionRef.current = session;
    const root = session?.cwd || projectRef.current.root;
    if (session?.id && root) {
      activeKeyRef.current = threadKey(root, session.id);
    } else {
      activeKeyRef.current = "";
    }
  }

  function eventThreadKey(event: StreamEvent): string {
    if (event.sessionId && event.cwd) return threadKey(event.cwd, event.sessionId);
    if (event.sessionId && sessionRef.current?.cwd) {
      return threadKey(sessionRef.current.cwd, event.sessionId);
    }
    return activeThreadKey();
  }

  function schedulePersist(key: string) {
    const entry = cacheRef.current[key];
    if (!entry?.sessionId || !entry.cwd) return;
    if (persistTimers.current[key]) window.clearTimeout(persistTimers.current[key]);
    persistTimers.current[key] = window.setTimeout(() => {
      void window.grokDeck.threads.set({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        messages: entry.messages,
        queue: entry.queue,
        updatedAt: Date.now(),
      });
    }, 280);
  }

  function persistNow(key: string) {
    const entry = cacheRef.current[key];
    if (!entry?.sessionId || !entry.cwd) return;
    if (persistTimers.current[key]) window.clearTimeout(persistTimers.current[key]);
    void window.grokDeck.threads.set({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      messages: entry.messages,
      queue: entry.queue,
      updatedAt: Date.now(),
    });
  }

  function touchCache(
    key: string,
    patch: Partial<{
      messages: ChatMessage[];
      queue: QueuedMessage[];
      busy: boolean;
      liveMessageId: string | null;
    }>,
  ) {
    const s = sessionRef.current;
    const prev = cacheRef.current[key];
    const cwd = prev?.cwd || eventCwdFromKey(key) || s?.cwd || projectRef.current.root || "";
    const sessionId = prev?.sessionId || key.split("::").slice(-1)[0] || s?.id || "";
    cacheRef.current[key] = {
      sessionId,
      cwd,
      messages: patch.messages ?? prev?.messages ?? (key === activeThreadKey() ? messagesRef.current : []),
      queue: patch.queue ?? prev?.queue ?? (key === activeThreadKey() ? queueRef.current : []),
      busy: patch.busy ?? prev?.busy ?? false,
      liveMessageId: patch.liveMessageId === undefined ? prev?.liveMessageId ?? null : patch.liveMessageId,
    };
    schedulePersist(key);
  }

  function eventCwdFromKey(key: string): string {
    const idx = key.lastIndexOf("::");
    return idx > 0 ? key.slice(0, idx) : "";
  }

  function threadMessages(k: string): ChatMessage[] {
    if (k === activeThreadKey()) return messagesRef.current;
    return cacheRef.current[k]?.messages || [];
  }

  /** New user turn: never reuse the previous assistant bubble for the next reply. */
  function beginUserTurn() {
    const key = activeThreadKey();
    if (key) streamingByKey.current[key] = null;
    streamingId.current = null;
    setLiveMessageId(null);
    liveIdRef.current = null;
    setBusy(true);
    busyRef.current = true;
    turnStartRef.current = Date.now();
    setLastTurnMs(null);
    stickToBottomRef.current = true;
    usageBaselineRef.current = officialUsed(usageRef.current);
  }

  function ensureAssistantMessage(key?: string): string {
    const k = key || activeThreadKey();
    const existing = streamingByKey.current[k] || (k === activeThreadKey() ? streamingId.current : null);
    if (existing) {
      const msgs = threadMessages(k);
      const aIdx = msgs.findIndex((m) => m.id === existing);
      let lastUser = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "user") {
          lastUser = i;
          break;
        }
      }
      // Only reuse if this bubble is the reply sitting after the latest user message
      if (aIdx >= 0 && aIdx > lastUser) return existing;
      if (aIdx >= 0 && aIdx <= lastUser) {
        const stale = msgs[aIdx];
        if (stale?.content) {
          patchAssistant(existing, (m) => ({ ...m, content: closeOpenFences(m.content) }), k);
        }
      }
    }
    const id = uid("a");
    streamingByKey.current[k] = id;
    if (k === activeThreadKey()) {
      streamingId.current = id;
      setLiveMessageId(id);
      liveIdRef.current = id;
    }
    const add = (prev: ChatMessage[]) => [
      ...prev,
      { id, role: "assistant" as const, content: "", thoughts: "", toolCalls: [], createdAt: Date.now() },
    ];
    if (k === activeThreadKey()) {
      setMessages((prev) => {
        const next = add(prev);
        messagesRef.current = next;
        touchCache(k, { messages: next, liveMessageId: id, busy: true });
        return next;
      });
    } else {
      const prev = cacheRef.current[k]?.messages || [];
      touchCache(k, { messages: add(prev), liveMessageId: id, busy: true });
    }
    return id;
  }

  function patchAssistant(id: string, patch: (m: ChatMessage) => ChatMessage, key?: string) {
    const k = key || activeThreadKey();
    const apply = (prev: ChatMessage[]) => prev.map((m) => (m.id === id ? patch(m) : m));
    if (k === activeThreadKey()) {
      setMessages((prev) => {
        const next = apply(prev);
        messagesRef.current = next;
        touchCache(k, { messages: next });
        return next;
      });
    } else {
      const prev = cacheRef.current[k]?.messages || [];
      touchCache(k, { messages: apply(prev) });
    }
  }

  function notifyTurnFinished(args: {
    onActive: boolean;
    durationMs?: number;
    stopReason?: string;
  }) {
    if (args.stopReason === "cancelled") return;
    const s = settingsRef.current;
    const wantMsg = s.notifyMessage !== false;
    const wantSound = s.notifySound !== false;
    if (!wantMsg && !wantSound) return;
    if (wantSound) void playDoneChime();
    if (!wantMsg) return;
    const dur = args.durationMs != null ? formatDuration(args.durationMs) : "";
    const title = args.onActive ? sessionRef.current?.title || "Grok Deck" : "Grok Deck";
    const body = args.onActive
      ? dur
        ? `작업이 끝났습니다 · ${dur}`
        : "작업이 끝났습니다"
      : dur
        ? `다른 스레드 작업이 끝났습니다 · ${dur}`
        : "다른 스레드 작업이 끝났습니다";
    void window.grokDeck.app.notify({
      title,
      body,
      silent: wantSound,
      force: !args.onActive,
    });
  }

  function handleStreamEvent(event: StreamEvent) {
    const key = eventThreadKey(event);
    switch (event.type) {
      case "text": {
        const id = ensureAssistantMessage(key);
        patchAssistant(id, (m) => ({ ...m, content: m.content + event.text }), key);
        break;
      }
      case "thought": {
        const id = ensureAssistantMessage(key);
        patchAssistant(id, (m) => ({ ...m, thoughts: (m.thoughts || "") + event.text }), key);
        break;
      }
      case "tool_call": {
        const id = ensureAssistantMessage(key);
        patchAssistant(id, (m) => {
          const toolCalls = [
            ...(m.toolCalls || []).filter((t) => t.id !== event.call.id),
            event.call,
          ];
          const fromTools = editFilesFromTools(toolCalls);
          return {
            ...m,
            toolCalls,
            editSummary:
              fromTools.length > 0
                ? {
                    ghostCommitId: m.editSummary?.ghostCommitId || `pending_${id}`,
                    files: m.editSummary?.files?.length
                      ? mergeEditFiles(m.editSummary.files, fromTools)
                      : fromTools,
                  }
                : m.editSummary,
          };
        }, key);
        break;
      }
      case "tool_call_update": {
        const id = ensureAssistantMessage(key);
        patchAssistant(id, (m) => {
          const toolCalls = (m.toolCalls || []).map((t) =>
            t.id === event.call.id
              ? { ...t, ...event.call, diffs: event.call.diffs || t.diffs }
              : t,
          );
          // Keep a provisional edit summary so the card can appear as soon as the turn ends
          const fromTools = editFilesFromTools(toolCalls);
          const editSummary =
            fromTools.length > 0
              ? {
                  ghostCommitId: m.editSummary?.ghostCommitId || `pending_${id}`,
                  files: m.editSummary?.files?.length ? mergeEditFiles(m.editSummary.files, fromTools) : fromTools,
                }
              : m.editSummary;
          return { ...m, toolCalls, editSummary };
        }, key);
        break;
      }
      case "plan": {
        const id = ensureAssistantMessage(key);
        patchAssistant(id, (m) => ({ ...m, plan: event.entries }), key);
        if (event.entries?.length) {
          setActivePlan((prev) => ({
            path: prev?.path || "plan",
            content:
              prev?.content ||
              event.entries.map((e, i) => `${i + 1}. ${e.content}`).join("\n"),
            entries: event.entries,
            updatedAt: Date.now(),
          }));
          setPlanDismissed(false);
        }
        break;
      }
      case "plan_document": {
        setActivePlan(event.plan);
        setPlanDismissed(false);
        break;
      }
      case "permission_request": {
        setPermissionQueue((q) => [
          ...q,
          {
            requestId: event.requestId,
            source: event.source,
            title: event.title,
            detail: event.detail,
            path: event.path,
            toolCall: event.toolCall,
            options: event.options || [],
          },
        ]);
        setStatusLine(`Permission · ${event.title}`);
        break;
      }
      case "file_changed":
        if (event.action === "write") setStatusLine(`Wrote ${fileName(event.path)}`);
        break;
      case "diff":
        setChangedFiles((prev) => {
          const next = new Map(prev);
          next.set(event.diff.path, event.diff);
          return next;
        });
        setSelectedDiff((cur) => cur ?? event.diff.path);
        break;
      case "mode":
        setMode(event.mode);
        break;
      case "usage":
        setUsage((prev) => ({
          ...(prev || {}),
          ...event.usage,
          // Keep previous token counts if update only carries limit
          totalTokens: event.usage.totalTokens ?? prev?.totalTokens,
          inputTokens: event.usage.inputTokens ?? prev?.inputTokens,
          outputTokens: event.usage.outputTokens ?? prev?.outputTokens,
          cachedReadTokens: event.usage.cachedReadTokens ?? prev?.cachedReadTokens,
          reasoningTokens: event.usage.reasoningTokens ?? prev?.reasoningTokens,
          contextLimit: event.usage.contextLimit ?? prev?.contextLimit,
          compactedAt: event.usage.compactedAt ?? prev?.compactedAt,
          tokensBeforeCompact: event.usage.tokensBeforeCompact ?? prev?.tokensBeforeCompact,
        }));
        break;
      case "compact":
        setCompact({
          status: event.status,
          before: event.before,
          after: event.after,
          at: event.status === "done" ? Date.now() : undefined,
          message: event.message,
        });
        if (event.usage) {
          setUsage((prev) => ({ ...(prev || {}), ...event.usage }));
        }
        if (event.status === "started") setStatusLine(event.message || "Context 자동 압축 중…");
        if (event.status === "done") setStatusLine(event.message || "Context 정리됨");
        if (event.status === "failed") setStatusLine(event.message || "Context 압축 실패");
        break;
      case "context_limit":
        setUsage((u) => ({
          ...(u || {}),
          contextLimit: event.limit,
          // Do NOT invent totalTokens: 0 — meter shows "—" until real usage arrives
        }));
        break;
      case "ghost_commit": {
        setGhost((g) => ({
          canUndo: true,
          depth: Math.max((g.depth || 0) + 1, 1),
          last: {
            id: event.commit.id,
            createdAt: event.commit.createdAt,
            message: event.commit.message,
            fileCount: event.commit.fileCount,
          },
        }));
        setStatusLine(`Ghost · ${event.commit.fileCount} files snapshotted`);
        // Attach per-turn edit summary to the live assistant message (must survive turn_done)
        const files =
          event.commit.files && event.commit.files.length > 0
            ? event.commit.files
            : (event.commit.paths || []).map((path) => ({ path, add: 0, del: 0 }));
        const summary = {
          ghostCommitId: event.commit.id,
          files,
        };
        const targetId = streamingId.current || liveMessageId;
        setMessages((prev) => {
          const next = [...prev];
          let idx = targetId ? next.findIndex((m) => m.id === targetId) : -1;
          if (idx < 0) {
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i]?.role === "assistant") {
                idx = i;
                break;
              }
            }
          }
          if (idx >= 0 && files.length > 0) {
            next[idx] = { ...next[idx]!, editSummary: summary };
          }
          return next;
        });
        break;
      }
      case "ghost_status":
        setGhost(event.ghost);
        break;
      case "commands":
        // Merge agent-advertised cmds; re-fetch to include disk skills
        setSlashCmds(mergeCommands(event.commands));
        void window.grokDeck.agent.getCommands().then((c) => setSlashCmds(mergeCommands(c)));
        break;
      case "ghost_undo":
        setGhost((g) => ({
          canUndo: Math.max(0, (g.depth || 1) - 1) > 0,
          depth: Math.max(0, (g.depth || 1) - 1),
          last: undefined,
        }));
        void window.grokDeck.ghost.status().then(setGhost);
        break;
      case "turn_done": {
        if (cancelTimerRef.current) {
          window.clearTimeout(cancelTimerRef.current);
          cancelTimerRef.current = null;
        }
        const onActive = key === activeThreadKey();
        const finishedId =
          streamingByKey.current[key] ||
          (onActive ? streamingId.current || liveIdRef.current : cacheRef.current[key]?.liveMessageId);
        streamingByKey.current[key] = null;
        if (onActive) {
          setBusy(false);
          busyRef.current = false;
          streamingId.current = null;
          setLiveMessageId(null);
          liveIdRef.current = null;
        }
        touchCache(key, { busy: false, liveMessageId: null });
        persistNow(key);
        const duration =
          event.durationMs ??
          (turnStartRef.current ? Date.now() - turnStartRef.current : undefined);
        turnStartRef.current = null;
        if (onActive && duration != null) setLastTurnMs(duration);
        if (onActive && event.usage) {
          setUsage((prev) => ({
            ...(prev || {}),
            ...event.usage,
            totalTokens: event.usage!.totalTokens ?? prev?.totalTokens,
            inputTokens: event.usage!.inputTokens ?? prev?.inputTokens,
            outputTokens: event.usage!.outputTokens ?? prev?.outputTokens,
            contextLimit: event.usage!.contextLimit ?? prev?.contextLimit,
          }));
        }
        if (onActive && event.ghost) setGhost(event.ghost);
        const finalize = (prev: ChatMessage[]) => {
          const next = [...prev];
          let idx = finishedId ? next.findIndex((m) => m.id === finishedId) : -1;
          if (idx < 0) {
            let lastUser = -1;
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i]?.role === "user") {
                lastUser = i;
                break;
              }
            }
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i]?.role === "assistant" && i > lastUser) {
                idx = i;
                break;
              }
            }
            if (idx < 0) {
              for (let i = (lastUser > 0 ? lastUser : next.length) - 1; i >= 0; i--) {
                if (next[i]?.role === "assistant") {
                  idx = i;
                  break;
                }
              }
            }
          }
          if (idx < 0) return prev;
          const m = next[idx]!;
          let editSummary = m.editSummary;
          if (!editSummary?.files?.length) {
            const fromTools = editFilesFromTools(m.toolCalls);
            if (fromTools.length) {
              editSummary = {
                ghostCommitId: event.ghost?.last?.id || m.editSummary?.ghostCommitId || `turn_${m.id}`,
                files: fromTools,
              };
            }
          }
          next[idx] = {
            ...m,
            content: closeOpenFences(m.content),
            ...(duration != null ? { durationMs: duration } : {}),
            ...(editSummary ? { editSummary } : {}),
          };
          return next;
        };
        if (onActive) {
          setMessages((prev) => {
            const next = finalize(prev);
            messagesRef.current = next;
            touchCache(key, { messages: next, busy: false, liveMessageId: null });
            return next;
          });
        } else {
          const prev = cacheRef.current[key]?.messages || [];
          touchCache(key, { messages: finalize(prev), busy: false, liveMessageId: null });
        }
        persistNow(key);
        if (onActive) {
          setStatusLine(
            event.stopReason
              ? `Done · ${event.stopReason}${duration ? ` · ${formatDuration(duration)}` : ""}`
              : duration
                ? `Done · ${formatDuration(duration)}`
                : "Done",
          );
          const rest = queueRef.current;
          if (rest.length) {
            const [nxt, ...left] = rest;
            setQueue(left);
            queueRef.current = left;
            touchCache(key, { queue: left });
            window.setTimeout(() => {
              if (nxt?.text) void submitRef.current(nxt.text, []);
            }, 80);
          } else {
            notifyTurnFinished({
              onActive: true,
              durationMs: duration,
              stopReason: event.stopReason,
            });
          }
        } else {
          const rest = cacheRef.current[key]?.queue || [];
          if (!rest.length) {
            notifyTurnFinished({
              onActive: false,
              durationMs: duration,
              stopReason: event.stopReason,
            });
          }
        }
        void refreshSessions();
        if (onActive) void window.grokDeck.ghost.status().then(setGhost);
        break;
      }
      case "error":
        streamingByKey.current[key] = null;
        if (key === activeThreadKey()) {
          setBusy(false);
          busyRef.current = false;
          streamingId.current = null;
          setLiveMessageId(null);
        }
        touchCache(key, { busy: false, liveMessageId: null });
        persistNow(key);
        setStatusLine(event.message);
        setMessages((prev) => [
          ...prev,
          { id: uid("err"), role: "system", content: event.message, createdAt: Date.now() },
        ]);
        break;
      case "status":
        setStatusLine(event.message.slice(0, 160));
        break;
    }
  }

  async function applyMode(next: DeckMode) {
    const m = await window.grokDeck.agent.setMode(next);
    setMode(m);
    setSettings((s) => ({ ...s, deckMode: m }));
    setStatusLine(`Mode: ${deckModeLabel(m)}`);
    if (m === "plan") {
      try {
        const p = await window.grokDeck.agent.getPlan();
        if (p) {
          setActivePlan(p);
          setPlanDismissed(false);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /** Send a prompt without using the composer draft (plan implement / revise). */
  async function sendAgentText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (auth.state !== "authenticated") {
      setStatusLine("Sign in with Grok first");
      return;
    }
    if (!project.root) {
      setStatusLine("Open a project first");
      return;
    }
    if (agentStatus.state === "idle" || agentStatus.state === "error") {
      await window.grokDeck.agent.start(project.root);
    }
    beginUserTurn();
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: trimmed,
      createdAt: Date.now(),
    };
    const nextMsgs = [...messagesRef.current, userMsg];
    messagesRef.current = nextMsgs;
    setMessages(nextMsgs);
    const key = activeThreadKey();
    if (key) touchCache(key, { messages: nextMsgs, busy: true });
    try {
      await window.grokDeck.agent.prompt({ text: trimmed });
    } catch (err) {
      const k = activeThreadKey();
      if (k) streamingByKey.current[k] = null;
      setBusy(false);
      busyRef.current = false;
      streamingId.current = null;
      setLiveMessageId(null);
      turnStartRef.current = null;
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImplementPlan(notes: string) {
    setPlanDismissed(true);
    setStatusLine("계획 적용 · Always-approve 모드로 구현 시작");
    await applyMode("yolo");
    const body = notes.trim()
      ? [
          "Approve and implement the plan as written.",
          "Apply these adjustments from the user before/while implementing:",
          "",
          notes.trim(),
          "",
          "Start implementing now. You are in always-approve mode — make the real code changes.",
        ].join("\n")
      : [
          "Approve and implement the plan as written.",
          "Start implementing now. You are in always-approve mode — make the real code/file changes in the project.",
        ].join("\n");
    await sendAgentText(body);
  }

  async function onRevisePlan(notes: string) {
    if (!notes.trim()) return;
    setStatusLine("계획 수정 요청 (Plan 모드 유지)");
    // Stay in plan mode so only plan.md can change
    if (mode !== "plan") await applyMode("plan");
    await sendAgentText(
      [
        "Revise the plan based on this user feedback. Update plan.md only — do not implement yet.",
        "",
        notes.trim(),
      ].join("\n"),
    );
  }

  async function cycleMode() {
    await applyMode(nextDeckMode(mode));
  }

  async function onLogin() {
    setLoginBusy(true);
    try {
      const res = await window.grokDeck.auth.login();
      setAuth(res.status);
      setStatusLine(res.ok ? "Signed in" : res.message || "Login failed");
    } finally {
      setLoginBusy(false);
    }
  }

  async function onOpenProject() {
    const state = await window.grokDeck.project.open();
    setProject(state);
    if (state.root) {
      setMessages([]);
      setChangedFiles(new Map());
      setSelectedDiff(null);
      setPermissionQueue([]);
      adoptSession(null);
      setActivePlan(null);
      setPlanDismissed(false);
      streamingId.current = null;
      setStatusLine(state.root);
      await refreshSessions();
      const st = await window.grokDeck.agent.getStatus();
      setAgentStatus(st);
      // Restore Ghost Git depth + last context from disk for this project
      try {
        setGhost(await window.grokDeck.ghost.status());
      } catch {
        /* ignore */
      }
    }
  }

  /** New chat inside current project */
  async function onNewSessionInProject(cwd?: string) {
    flushActiveThread();
    const root = cwd || project.root;
    if (!root) {
      setNewProjectOpen(true);
      return;
    }
    setMessages([]);
    messagesRef.current = [];
    setQueue([]);
    queueRef.current = [];
    setChangedFiles(new Map());
    setSelectedDiff(null);
    setPermissionQueue([]);
    adoptSession(null);
    streamingId.current = null;
    setLiveMessageId(null);
    setBusy(false);
    busyRef.current = false;
    setProject((p) => ({ ...p, root }));
    projectRef.current = { ...projectRef.current, root };
    const st = await window.grokDeck.agent.start(root);
    setAgentStatus(st);
    if (st.state === "ready" && "sessionId" in st && st.sessionId) {
      const created: SessionSummary = {
        id: st.sessionId,
        cwd: st.cwd || root,
        title: "새 세션",
      };
      adoptSession(created);
      cacheRef.current[threadKey(created.cwd, created.id)] = {
        sessionId: created.id,
        cwd: created.cwd,
        messages: [],
        queue: [],
        busy: false,
        liveMessageId: null,
      };
    }
    setStatusLine("새 세션 시작");
    try {
      setGhost(await window.grokDeck.ghost.status());
    } catch {
      /* ignore */
    }
    await refreshSessions();
  }

  /** Codex-style: create a new project folder under Documents */
  async function onCreateProject() {
    const name = newProjectName.trim();
    if (!name) {
      setStatusLine("프로젝트 이름을 입력하세요");
      return;
    }
    setCreatingProject(true);
    try {
      const res = await window.grokDeck.project.create(name);
      if (!res.ok || !res.cwd) {
        setStatusLine(res.message || "프로젝트 생성 실패");
        return;
      }
      if (res.project) setProject(res.project);
      else setProject({ root: res.cwd, recent: [res.cwd] });
      projectRef.current = res.project || { root: res.cwd, recent: [res.cwd] };
      setMessages([]);
      messagesRef.current = [];
      setQueue([]);
      queueRef.current = [];
      setChangedFiles(new Map());
      setSelectedDiff(null);
      setPermissionQueue([]);
      adoptSession(null);
      streamingId.current = null;
      setNewProjectOpen(false);
      setNewProjectName("");
      setStatusLine(res.message);
      const st = await window.grokDeck.agent.getStatus();
      setAgentStatus(st);
      if (st.state === "ready" && "sessionId" in st && st.sessionId) {
        adoptSession({
          id: st.sessionId,
          cwd: st.cwd || res.cwd,
          title: name,
        });
      }
      await refreshSessions();
    } finally {
      setCreatingProject(false);
    }
  }

  async function onDeleteSession(cwd: string, sessionId: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    if (!confirm("이 세션을 삭제할까요? (디스크에서 제거됩니다)")) return;
    const res = await window.grokDeck.sessions.delete(sessionId, cwd);
    setStatusLine(res.message);
    if (activeSession?.id === sessionId) {
      adoptSession(null);
      setMessages([]);
    }
    await refreshSessions();
  }

  function flushActiveThread() {
    const key = activeKeyRef.current;
    const s = sessionRef.current;
    const root = s?.cwd || projectRef.current.root;
    if (!key || !s?.id || !root) return;
    if (!messagesRef.current.length && cacheRef.current[key]?.messages.length) return;
    const entry = {
      sessionId: s.id,
      cwd: root,
      messages: messagesRef.current,
      queue: queueRef.current,
      busy: busyRef.current,
      liveMessageId: liveIdRef.current,
    };
    cacheRef.current[key] = entry;
    persistNow(key);
  }

  async function openSession(group: ProjectGroup, session: SessionSummary) {
    flushActiveThread();
    setLoadingHistory(true);
    const bound = { ...session, cwd: group.cwd };
    const key = threadKey(group.cwd, bound.id);
    adoptSession(bound);
    setProject({ root: group.cwd, recent: project.recent });
    projectRef.current = { root: group.cwd, recent: project.recent };
    setChangedFiles(new Map());
    setSelectedDiff(null);
    setPermissionQueue([]);
    stickToBottomRef.current = true;

    const cached = cacheRef.current[key];
    const running = agentThreads.some(
      (t) => t.sessionId === bound.id && t.state === "running",
    );

    try {
      if (cached?.messages.length) {
        setMessages(cached.messages);
        messagesRef.current = cached.messages;
        setQueue(cached.queue || []);
        queueRef.current = cached.queue || [];
        setBusy(cached.busy || running);
        setLiveMessageId(cached.liveMessageId);
        streamingId.current = cached.liveMessageId;
        setStatusLine(`이어서 · ${bound.title}`);
      } else {
        streamingId.current = null;
        setLiveMessageId(null);
        const raw = await window.grokDeck.sessions.transcript(bound.id, group.cwd);
        const payload = Array.isArray(raw)
          ? { messages: raw, queue: [] as QueuedMessage[] }
          : raw;
        const mapped = (payload.messages || []).map((t) => ({
          ...t,
          toolCalls: t.toolCalls?.map((tc) => ({
            id: tc.id,
            title: tc.title,
            kind: tc.kind,
            status: (tc.status as ToolCallView["status"]) || "completed",
            input: tc.input,
          })),
        }));
        setMessages(mapped);
        messagesRef.current = mapped;
        setQueue(payload.queue || []);
        queueRef.current = payload.queue || [];
        setBusy(running);
        cacheRef.current[key] = {
          sessionId: bound.id,
          cwd: group.cwd,
          messages: mapped,
          queue: payload.queue || [],
          busy: running,
          liveMessageId: null,
        };
        setStatusLine(`Loaded · ${bound.title}`);
      }

      const st = await window.grokDeck.agent.loadSession(group.cwd, bound.id);
      setAgentStatus(st);
      if ("mode" in st && st.mode) setMode(st.mode);
      if (st.state === "error") {
        setStatusLine(st.message || "이 스레드 에이전트를 열지 못했습니다");
      }
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingHistory(false);
    }
  }

  async function refreshSlashCommands() {
    try {
      const remote = await window.grokDeck.agent.getCommands();
      setSlashCmds(mergeCommands(remote));
    } catch {
      /* keep current */
    }
  }

  async function handleSubmit(text: string, pendingAtts: ChatAttachment[]) {
    const trimmed = text.trim();
    if ((!trimmed && pendingAtts.length === 0) || busyRef.current) return;
    if (auth.state !== "authenticated") {
      setStatusLine("Sign in with Grok first");
      return;
    }
    if (!project.root) {
      setStatusLine("Open a project first");
      return;
    }

    const cwd = sessionRef.current?.cwd || project.root;
    let session = sessionRef.current;
    if (session?.id) {
      const st = await window.grokDeck.agent.loadSession(cwd, session.id);
      setAgentStatus(st);
      if (st.state === "error") {
        setStatusLine(st.message || "이 스레드를 이어갈 수 없습니다. 새 방을 만들지 않았습니다.");
        return;
      }
      if ("sessionId" in st && st.sessionId && st.sessionId !== session.id) {
        setStatusLine("에이전트가 다른 세션으로 열렸습니다. 전송을 취소했습니다.");
        return;
      }
    } else {
      const st = await window.grokDeck.agent.start(cwd);
      setAgentStatus(st);
      if (st.state !== "ready" || !("sessionId" in st) || !st.sessionId) {
        setStatusLine(st.state === "error" ? st.message : "새 세션을 시작하지 못했습니다");
        return;
      }
      session = {
        id: st.sessionId,
        cwd: st.cwd || cwd,
        title: "새 세션",
      };
      adoptSession(session);
    }

    const displayText = trimmed || (pendingAtts.length ? `(첨부 ${pendingAtts.length}개)` : "");
    beginUserTurn();
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: displayText,
      createdAt: Date.now(),
      attachments: pendingAtts,
    };
    const nextMsgs = [...messagesRef.current, userMsg];
    messagesRef.current = nextMsgs;
    setMessages(nextMsgs);
    const key = activeThreadKey();
    if (key) {
      touchCache(key, { messages: nextMsgs, busy: true });
      persistNow(key);
    }

    try {
      await window.grokDeck.agent.prompt({
        text: trimmed || "Please review the attached files.",
        sessionId: session?.id,
        cwd: session?.cwd || cwd,
        attachments: pendingAtts.map((a) => ({
          path: a.path,
          name: a.name,
          kind: a.kind,
          mimeType: a.mimeType,
        })),
      });
    } catch (err) {
      const k = activeThreadKey();
      if (k) streamingByKey.current[k] = null;
      setBusy(false);
      busyRef.current = false;
      streamingId.current = null;
      setLiveMessageId(null);
      turnStartRef.current = null;
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
  }
  submitRef.current = (text, atts) => {
    void handleSubmit(text, atts);
  };

  function enqueueMessage(text: string) {
    const item: QueuedMessage = { id: uid("q"), text, createdAt: Date.now() };
    setQueue((prev) => {
      const next = [...prev, item];
      queueRef.current = next;
      const key = activeThreadKey();
      if (key) {
        touchCache(key, { queue: next });
        persistNow(key);
      }
      return next;
    });
    setStatusLine("큐에 추가됨 · 현재 턴이 끝나면 자동 전송");
  }

  function editQueued(id: string, text: string) {
    setQueue((prev) => {
      const next = prev.map((q) => (q.id === id ? { ...q, text } : q));
      queueRef.current = next;
      const key = activeThreadKey();
      if (key) {
        touchCache(key, { queue: next });
        persistNow(key);
      }
      return next;
    });
  }

  function removeQueued(id: string) {
    setQueue((prev) => {
      const next = prev.filter((q) => q.id !== id);
      queueRef.current = next;
      const key = activeThreadKey();
      if (key) {
        touchCache(key, { queue: next });
        persistNow(key);
      }
      return next;
    });
  }

  function runQueued(id: string) {
    const item = queueRef.current.find((q) => q.id === id);
    if (!item) return;
    const rest = queueRef.current.filter((q) => q.id !== id);
    if (busy) {
      const next = [item, ...rest];
      setQueue(next);
      queueRef.current = next;
      const key = activeThreadKey();
      if (key) touchCache(key, { queue: next });
      setStatusLine("큐 맨 앞으로 올렸습니다. 현재 턴 다음 실행");
      return;
    }
    setQueue(rest);
    queueRef.current = rest;
    const key = activeThreadKey();
    if (key) {
      touchCache(key, { queue: rest });
      persistNow(key);
    }
    void handleSubmit(item.text, []);
  }

  async function onCancelTurn() {
    if (!busy) return;
    setStatusLine("취소 요청…");
    try {
      await window.grokDeck.agent.cancel();
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
    if (cancelTimerRef.current) window.clearTimeout(cancelTimerRef.current);
    cancelTimerRef.current = window.setTimeout(() => {
      setBusy((b) => {
        if (b) {
          const k = activeThreadKey();
          if (k) streamingByKey.current[k] = null;
          streamingId.current = null;
          setLiveMessageId(null);
          liveIdRef.current = null;
          busyRef.current = false;
          turnStartRef.current = null;
          setStatusLine("취소됨");
        }
        return false;
      });
    }, 6000);
  }

  async function openExternal(target: "explorer" | "powershell" | "cmd" | "vscode" | "cursor") {
    setOpenMenu(false);
    if (!project.root) {
      setStatusLine("프로젝트를 먼저 여세요 (새 작업 또는 프로젝트 열기)");
      return;
    }
    setStatusLine(`${target} 여는 중…`);
    try {
      const res = await window.grokDeck.project.openExternal(target, project.root);
      setStatusLine(res.ok ? res.message || `열림: ${target}` : res.message || "열기 실패");
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
  }

  function focusReview(path?: string) {
    if (path) setSelectedDiff(path);
    else if (changedFiles.size) setSelectedDiff([...changedFiles.keys()][0]!);
  }

  async function onGhostUndo() {
    setUndoing(true);
    try {
      const res = await window.grokDeck.ghost.undo();
      setStatusLine(res.message);
      if (res.ok) {
        setChangedFiles(new Map());
        setSelectedDiff(null);
      }
      setGhost(await window.grokDeck.ghost.status());
    } finally {
      setUndoing(false);
    }
  }

  async function saveSettingsLocal(next: AppSettings) {
    const saved = await window.grokDeck.settings.set(next);
    setSettings(saved);
  }

  const sidebarW = Math.min(
    PANEL_LIMITS.sidebarMax,
    Math.max(PANEL_LIMITS.sidebarMin, settings.sidebarWidth ?? DEFAULT_SETTINGS.sidebarWidth ?? 260),
  );
  const rightW = Math.min(
    PANEL_LIMITS.rightMax,
    Math.max(PANEL_LIMITS.rightMin, settings.rightWidth ?? DEFAULT_SETTINGS.rightWidth ?? 300),
  );

  const onSidebarDrag = useCallback((dx: number) => {
    setSettings((s) => {
      const cur = s.sidebarWidth ?? DEFAULT_SETTINGS.sidebarWidth ?? 260;
      const next = Math.min(
        PANEL_LIMITS.sidebarMax,
        Math.max(PANEL_LIMITS.sidebarMin, cur + dx),
      );
      return { ...s, sidebarWidth: next };
    });
  }, []);

  const onRightDrag = useCallback((dx: number) => {
    // Dragging the right divider: moving mouse left (negative dx) should grow right panel
    setSettings((s) => {
      const cur = s.rightWidth ?? DEFAULT_SETTINGS.rightWidth ?? 300;
      const next = Math.min(
        PANEL_LIMITS.rightMax,
        Math.max(PANEL_LIMITS.rightMin, cur - dx),
      );
      return { ...s, rightWidth: next };
    });
  }, []);

  const persistPanelWidths = useCallback(() => {
    setSettings((s) => {
      void window.grokDeck.settings.set(s);
      return s;
    });
  }, []);

  async function setEffort(effort: ReasoningEffort) {
    setSettings((s) => ({ ...s, reasoningEffort: effort }));
    await window.grokDeck.agent.setEffort(effort);
    setStatusLine(`추론 강도: ${effort}`);
  }

  async function refreshCustomThemes() {
    try {
      const cat = await window.grokDeck.themes.list();
      setCustomThemes(cat.themes || []);
    } catch {
      setCustomThemes([]);
    }
  }

  async function refreshRecentImages() {
    try {
      setRecentImages(await window.grokDeck.themes.recent());
    } catch {
      setRecentImages([]);
    }
  }

  async function resolveWallpaper(s: AppSettings, themes: CustomThemeInfo[]) {
    if (isCustomThemeId(s.theme) || s.customThemeId) {
      const id = isCustomThemeId(s.theme)
        ? customThemeKey(s.theme)
        : s.customThemeId!;
      const data = await window.grokDeck.themes.dataUrl(id);
      if (data) {
        setWallpaperSrc(data);
        return;
      }
      // Fallback protocol URL
      const meta = themes.find((t) => t.id === id);
      if (meta) {
        setWallpaperSrc(`deck-theme:///${encodeURIComponent(meta.file)}`);
        return;
      }
      setWallpaperSrc(null);
      return;
    }
    const builtin = THEMES.find((t) => t.id === s.theme);
    if (s.theme !== "dark" && builtin?.wallpaper) {
      setWallpaperSrc(`./${builtin.wallpaper}`);
    } else {
      setWallpaperSrc(null);
    }
  }

  async function setTheme(theme: ThemeId, customId?: string) {
    const builtin = THEMES.find((t) => t.id === theme);
    const isCustom = isCustomThemeId(theme) || Boolean(customId);
    const opacity = theme === "dark" && !isCustom
      ? 0
      : Math.max(0.28, builtin?.defaultOpacity ?? settings.wallpaperOpacity ?? 0.32);
    const next: AppSettings = {
      ...settings,
      theme,
      wallpaperOpacity: opacity,
      customThemeId: isCustomThemeId(theme)
        ? customThemeKey(theme)
        : customId,
    };
    setSettings(next);
    document.documentElement.dataset.theme = isCustom ? "custom" : theme;
    await resolveWallpaper(next, customThemes);
    try {
      await window.grokDeck.settings.set(next);
    } catch {
      /* keep local */
    }
    const label = isCustom
      ? customThemes.find((t) => t.id === (customId || customThemeKey(String(theme))))
          ?.label || "커스텀"
      : builtin?.label || theme;
    setStatusLine(`테마: ${label}`);
  }

  async function applyCustomTheme(t: CustomThemeInfo) {
    // Eagerly load image so background updates immediately
    const data = await window.grokDeck.themes.dataUrl(t.id);
    if (data) setWallpaperSrc(data);
    else setWallpaperSrc(`deck-theme:///${encodeURIComponent(t.file)}`);
    await setTheme(`custom:${t.id}`, t.id);
  }

  async function onImportThemeFile() {
    setThemeBusy(true);
    try {
      const res = await window.grokDeck.themes.importFile();
      setStatusLine(res.message);
      if (res.ok && res.theme) {
        await refreshCustomThemes();
        await applyCustomTheme(res.theme);
      }
    } finally {
      setThemeBusy(false);
    }
  }

  async function onImportLatestTheme() {
    setThemeBusy(true);
    try {
      const res = await window.grokDeck.themes.importLatest({
        sinceMs: Date.now() - 1000 * 60 * 60 * 24,
        prompt: aiThemePrompt,
      });
      setStatusLine(res.message);
      if (res.ok && res.theme) {
        await refreshCustomThemes();
        await applyCustomTheme(res.theme);
      }
    } finally {
      setThemeBusy(false);
    }
  }

  async function onGenerateTheme() {
    if (!project.root) {
      setStatusLine("프로젝트를 먼저 열어 주세요");
      return;
    }
    setThemeBusy(true);
    setStatusLine("이미지 생성 중… (최대 3분)");
    try {
      const res = await window.grokDeck.themes.generate(aiThemePrompt);
      setStatusLine(res.message);
      if (res.settings) setSettings(res.settings);
      await refreshCustomThemes();
      if (res.theme) await applyCustomTheme(res.theme);
    } finally {
      setThemeBusy(false);
    }
  }

  async function onDeleteCustomTheme(id: string) {
    if (!confirm("이 커스텀 테마를 삭제할까요?")) return;
    const res = await window.grokDeck.themes.delete(id);
    setStatusLine(res.message);
    await refreshCustomThemes();
    if (settings.customThemeId === id) {
      await setTheme("ember");
    }
  }

  function mergeCommands(remote: SlashCommand[]): SlashCommand[] {
    const map = new Map<string, SlashCommand>();
    for (const c of BUILTIN_SLASH) map.set(c.name.toLowerCase(), { ...c, kind: c.kind || "command" });
    for (const c of remote) {
      if (!c.name) continue;
      const key = c.name.toLowerCase();
      const prev = map.get(key);
      map.set(key, {
        ...prev,
        ...c,
        kind: c.kind || prev?.kind || "command",
        description: c.description || prev?.description || c.name,
      });
    }
    return [...map.values()].sort((a, b) => {
      // commands first, then skills
      const ak = a.kind === "skill" ? 1 : 0;
      const bk = b.kind === "skill" ? 1 : 0;
      if (ak !== bk) return ak - bk;
      return a.name.localeCompare(b.name);
    });
  }

  useEffect(() => {
    void refreshSlashCommands();
  }, [project.root, agentStatus.state]);

  async function runSlash(cmd: SlashCommand) {
    if (cmd.name === "new" || cmd.name === "clear") {
      await onNewSessionInProject();
      return;
    }
    if (cmd.name === "help") {
      const cmds = slashCmds.filter((c) => c.kind !== "skill");
      const skills = slashCmds.filter((c) => c.kind === "skill");
      setMessages((prev) => [
        ...prev,
        {
          id: uid("sys"),
          role: "system",
          content:
            "슬래시 명령:\n" +
            cmds.map((c) => `/${c.name} — ${c.description}`).join("\n") +
            (skills.length
              ? "\n\n스킬 ( /이름 으로 실행 ):\n" +
                skills.map((c) => `/${c.name} — ${c.description}`).join("\n")
              : "") +
            "\n\n파일 멘션: @파일명 · 첨부: 클립 아이콘 또는 드래그/붙여넣기",
          createdAt: Date.now(),
        },
      ]);
      return;
    }
    // Send to agent as slash command / skill (CLI parity)
    beginUserTurn();
    const userMsg: ChatMessage = {
      id: uid("u"),
      role: "user",
      content: `/${cmd.name}`,
      createdAt: Date.now(),
    };
    const nextMsgs = [...messagesRef.current, userMsg];
    messagesRef.current = nextMsgs;
    setMessages(nextMsgs);
    const slashKey = activeThreadKey();
    if (slashKey) touchCache(slashKey, { messages: nextMsgs, busy: true });
    try {
      if (agentStatus.state === "idle" || agentStatus.state === "error") {
        if (project.root) await window.grokDeck.agent.start(project.root);
      }
      await window.grokDeck.agent.prompt(`/${cmd.name}`);
    } catch (err) {
      const k = activeThreadKey();
      if (k) streamingByKey.current[k] = null;
      setBusy(false);
      busyRef.current = false;
      streamingId.current = null;
      setLiveMessageId(null);
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
  }

  const customActive = isCustomThemeId(settings.theme)
    ? customThemes.find((t) => t.id === customThemeKey(settings.theme)) ||
      customThemes.find((t) => t.id === settings.customThemeId)
    : settings.customThemeId
      ? customThemes.find((t) => t.id === settings.customThemeId)
      : undefined;

  // With translucent panels, keep wallpaper opacity high enough to see the photo
  const wallOpacity =
    settings.theme === "dark" && !customActive && !wallpaperSrc
      ? 0
      : Math.max(0.45, Math.min(0.85, settings.wallpaperOpacity ?? 0.55));

  async function onPermission(optionId: string) {
    if (!permission) return;
    const id = permission.requestId;
    setPermissionQueue((q) => q.slice(1));
    await window.grokDeck.agent.respondPermission(id, optionId);
  }

  const authLabel =
    auth.state === "authenticated"
      ? auth.email || "Signed in"
      : auth.state === "unauthenticated"
        ? "Not signed in"
        : auth.state === "error"
          ? auth.message
          : "…";

  const agentDot =
    agentStatus.state === "ready" || agentStatus.state === "running"
      ? "ok"
      : agentStatus.state === "error"
        ? "err"
        : agentStatus.state === "starting"
          ? "warn"
          : "";

  const title =
    activeSession?.title ||
    (project.root ? shortPath(project.root) : "Grok Deck");

  const orderedProjects = useMemo(() => {
    const order = settings.projectOrder;
    if (!order?.length) return projects;
    const rank = new Map(order.map((c, i) => [c.replace(/\\/g, "/").toLowerCase(), i]));
    const known: ProjectGroup[] = [];
    const unknown: ProjectGroup[] = [];
    for (const g of projects) {
      const k = g.cwd.replace(/\\/g, "/").toLowerCase();
      if (rank.has(k)) known.push(g);
      else unknown.push(g);
    }
    known.sort((a, b) => {
      const ia = rank.get(a.cwd.replace(/\\/g, "/").toLowerCase()) ?? 0;
      const ib = rank.get(b.cwd.replace(/\\/g, "/").toLowerCase()) ?? 0;
      return ia - ib;
    });
    return [...unknown, ...known];
  }, [projects, settings.projectOrder]);

  usageRef.current = usage;
  messagesRef.current = messages;
  queueRef.current = queue;
  busyRef.current = busy;
  liveIdRef.current = liveMessageId;
  sessionRef.current = activeSession;
  projectRef.current = project;
  settingsRef.current = settings;

  const estimatedTokens = useMemo(() => estimateTranscriptTokens(messages), [messages]);

  const liveExtra = useMemo(() => {
    if (!busy) return 0;
    let extra = 0;
    if (liveMessageId) {
      const live = messages.find((m) => m.id === liveMessageId);
      if (live) extra += estimateMessageTokens(live);
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        extra += estimateMessageTokens(messages[i]!);
        break;
      }
    }
    return extra;
  }, [busy, liveMessageId, messages]);

  function persistExpanded(next: Record<string, boolean>) {
    setExpanded(next);
    void saveSettingsLocal({ ...settings, sidebarExpanded: next });
  }

  function toggleProject(cwd: string, currentlyOpen: boolean) {
    persistExpanded({ ...expanded, [cwd]: !currentlyOpen });
  }

  function onDropProject(targetCwd: string) {
    if (!dragCwd || dragCwd === targetCwd) {
      setDragCwd(null);
      setOverCwd(null);
      return;
    }
    const cur = orderedProjects.map((g) => g.cwd);
    const from = cur.findIndex((c) => c === dragCwd);
    const to = cur.findIndex((c) => c === targetCwd);
    if (from < 0 || to < 0) {
      setDragCwd(null);
      setOverCwd(null);
      return;
    }
    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    void saveSettingsLocal({ ...settings, projectOrder: next });
    setDragCwd(null);
    setOverCwd(null);
  }

  const fileList = [...changedFiles.keys()];
  const activeDiff = selectedDiff ? changedFiles.get(selectedDiff) : undefined;
  const totalStats = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const d of changedFiles.values()) {
      const s = relativeDiffStats(d);
      add += s.add;
      del += s.del;
    }
    return { add, del, count: changedFiles.size };
  }, [changedFiles]);

  return (
    <div
      className={`shell theme-${settings.theme}${wallpaperSrc && wallOpacity > 0 ? " has-wallpaper" : ""}`}
      style={
        {
          ["--sidebar-w" as string]: `${sidebarW}px`,
          ["--right-w" as string]: `${rightW}px`,
        } as CSSProperties
      }
    >
      <ResizeHandles />
      {wallpaperSrc && wallOpacity > 0 ? (
        <div
          className="app-wallpaper"
          key={wallpaperSrc.slice(0, 64)}
          style={{
            backgroundImage: `url("${wallpaperSrc}")`,
            opacity: wallOpacity,
          }}
        />
      ) : null}

      {/* ── Left: Codex-style nav ── */}
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="logo">
            <img className="logo-img" src="./logo.png" alt="" />
            <span className="logo-text">
              Grok Deck
              {appVersion ? <span className="logo-ver">v{appVersion}</span> : null}
            </span>
          </div>
        </div>

        <button className="nav-btn primary" onClick={() => setNewProjectOpen(true)}>
          <span className="nav-icon">✎</span>
          새 작업
        </button>

        <button className="nav-btn" onClick={() => void onOpenProject()}>
          <span className="nav-icon">📁</span>
          프로젝트 열기
        </button>
        <button className="nav-btn" onClick={() => void refreshSessions()}>
          <span className="nav-icon">↻</span>
          세션 새로고침
        </button>
        <button className="nav-btn" onClick={() => setShowSettings((v) => !v)}>
          <span className="nav-icon">⚙</span>
          설정
        </button>

        <div className="sidebar-scroll">
          {showSettings ? (
            <div className="settings-drawer">
              <div className="settings-tabs">
                {(
                  [
                    ["general", "일반"],
                    ["theme", "테마"],
                    ["ai", "AI 테마"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`settings-tab ${settingsTab === id ? "active" : ""}`}
                    onClick={() => setSettingsTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {settingsTab === "general" ? (
                <>
                  <div className="field">
                    <label>모델</label>
                    <input
                      value={settings.model}
                      onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                      onBlur={() => void saveSettingsLocal(settings)}
                    />
                  </div>
                  <div className="field">
                    <label>추론 강도</label>
                    <select
                      value={settings.reasoningEffort}
                      onChange={(e) => void setEffort(e.target.value as ReasoningEffort)}
                    >
                      {REASONING_EFFORTS.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Grok CLI 경로</label>
                    <input
                      value={settings.grokPath}
                      onChange={(e) => setSettings({ ...settings, grokPath: e.target.value })}
                      onBlur={() => void saveSettingsLocal(settings)}
                    />
                  </div>
                  <div className="settings-notify">
                    <h4>알림</h4>
                    <p className="muted" style={{ margin: "0 0 8px" }}>
                      대화나 작업이 끝나면 알려줍니다. 각각 따로 켤 수 있습니다.
                    </p>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.notifyMessage !== false}
                        onChange={(e) => {
                          const next = { ...settings, notifyMessage: e.target.checked };
                          setSettings(next);
                          void saveSettingsLocal(next);
                        }}
                      />
                      메시지 알림
                    </label>
                    <p className="muted notify-hint">창이 뒤에 있거나 다른 스레드가 끝나면 Windows 알림</p>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.notifySound !== false}
                        onChange={(e) => {
                          const next = { ...settings, notifySound: e.target.checked };
                          setSettings(next);
                          void saveSettingsLocal(next);
                        }}
                      />
                      소리 알림
                      <button
                        type="button"
                        className="btn btn-sm notify-preview"
                        onClick={() => void playDoneChime()}
                      >
                        미리듣기
                      </button>
                    </label>
                    <p className="muted notify-hint">작업이 끝나면 차임을 재생합니다</p>
                  </div>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={showNoiseSessions}
                      onChange={(e) => setShowNoiseSessions(e.target.checked)}
                    />
                    짧은/테스트 세션 모두 표시
                  </label>
                  <p className="muted">
                    기본적으로 제목 없는 짧은 세션·스모크 테스트는 숨깁니다.
                  </p>
                </>
              ) : null}

              {settingsTab === "theme" ? (
                <>
                  <div className="field">
                    <label>기본 테마 (즉시 적용)</label>
                    <div className="theme-grid">
                      {THEMES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`theme-swatch ${settings.theme === t.id ? "active" : ""}`}
                          onClick={() => void setTheme(t.id)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>커스텀 테마</label>
                    {customThemes.length === 0 ? (
                      <p className="muted">아직 없음 — AI 테마 탭에서 생성·가져오기</p>
                    ) : (
                      <div className="custom-theme-list">
                        {customThemes.map((t) => (
                          <div
                            key={t.id}
                            className={`custom-theme-item ${settings.customThemeId === t.id || settings.theme === `custom:${t.id}` ? "active" : ""}`}
                          >
                            <button
                              type="button"
                              className="custom-theme-preview"
                              onClick={() => void applyCustomTheme(t)}
                              ref={(el) => {
                                if (!el || el.dataset.loaded === "1") return;
                                el.dataset.loaded = "1";
                                void window.grokDeck.themes.dataUrl(t.id).then((url) => {
                                  if (url) el.style.backgroundImage = `url("${url}")`;
                                });
                              }}
                              title={t.label}
                            />
                            <div className="custom-theme-meta">
                              <button type="button" onClick={() => void applyCustomTheme(t)}>
                                {t.label}
                              </button>
                              <button
                                type="button"
                                className="thread-del"
                                onClick={() => void onDeleteCustomTheme(t.id)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="field">
                    <label>배경 강도 ({Math.round(wallOpacity * 100)}%)</label>
                    <input
                      type="range"
                      min={0}
                      max={50}
                      value={Math.round(wallOpacity * 100)}
                      onChange={(e) => {
                        const opacity = Number(e.target.value) / 100;
                        setSettings((s) => ({ ...s, wallpaperOpacity: opacity }));
                      }}
                      onMouseUp={(e) => {
                        const opacity = Number((e.target as HTMLInputElement).value) / 100;
                        void saveSettingsLocal({ ...settings, wallpaperOpacity: opacity });
                      }}
                    />
                  </div>
                </>
              ) : null}

              {settingsTab === "ai" ? (
                <>
                  <p className="muted">
                    Grok CLI <code>/imagine</code> 으로 배경을 만들고, 자동으로 테마 슬롯에 넣습니다.
                    (영상 <code>/imagine-video</code> 는 프롬프트만 지원)
                  </p>
                  <div className="field">
                    <label>테마 프롬프트</label>
                    <textarea
                      className="ai-theme-input"
                      value={aiThemePrompt}
                      onChange={(e) => setAiThemePrompt(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="stack" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={themeBusy}
                      onClick={() => void onGenerateTheme()}
                    >
                      {themeBusy ? "생성·적용 중…" : "생성 후 테마로 적용"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={themeBusy}
                      onClick={() => void onImportLatestTheme()}
                    >
                      최근 생성 이미지 가져오기
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={themeBusy}
                      onClick={() => void onImportThemeFile()}
                    >
                      파일에서 가져오기…
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setDraftSeedText(`/imagine-video ${aiThemePrompt}`);
                        setDraftSeed((n) => n + 1);
                        setShowSettings(false);
                      }}
                    >
                      /imagine-video 프롬프트만 넣기
                    </button>
                  </div>
                  {recentImages.length > 0 ? (
                    <div className="field" style={{ marginTop: 10 }}>
                      <label>최근 이미지 (클릭 = 테마로)</label>
                      <div className="recent-img-grid">
                        {recentImages.slice(0, 8).map((img) => (
                          <button
                            key={img.path}
                            type="button"
                            className="recent-img"
                            title={img.path}
                            disabled={themeBusy}
                            onClick={async () => {
                              setThemeBusy(true);
                              try {
                                const res = await window.grokDeck.themes.importPath(
                                  img.path,
                                  img.path.split(/[/\\]/).pop(),
                                );
                                setStatusLine(res.message);
                                if (res.ok && res.theme) {
                                  await refreshCustomThemes();
                                  await applyCustomTheme(res.theme);
                                }
                              } finally {
                                setThemeBusy(false);
                              }
                            }}
                          >
                            <span className="recent-img-name">
                              {img.path.split(/[/\\]/).pop()}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <p className="muted" style={{ marginTop: 8 }}>
                    저장 위치: <code>~/.grokdeck/themes/</code>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}

          <div className="section-label">프로젝트</div>
          {orderedProjects.length === 0 ? (
            <p className="muted" style={{ padding: "0 10px" }}>
              <strong>새 작업</strong>으로 Documents 아래 프로젝트를 만들거나, 기존 폴더를 여세요.
            </p>
          ) : (
            orderedProjects.map((g) => {
              const open = expanded[g.cwd] !== false;
              return (
                <div
                  className={`project-block${dragCwd === g.cwd ? " dragging" : ""}${overCwd === g.cwd ? " drag-over" : ""}`}
                  key={g.cwd}
                  onDragOver={(e) => {
                    if (!dragCwd || dragCwd === g.cwd) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overCwd !== g.cwd) setOverCwd(g.cwd);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    onDropProject(g.cwd);
                  }}
                  onDragLeave={() => {
                    if (overCwd === g.cwd) setOverCwd(null);
                  }}
                >
                  <div className="project-head-row">
                    <button
                      type="button"
                      className="project-drag"
                      title="드래그해서 순서 변경"
                      draggable
                      onDragStart={(e) => {
                        setDragCwd(g.cwd);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", g.cwd);
                      }}
                      onDragEnd={() => {
                        setDragCwd(null);
                        setOverCwd(null);
                      }}
                    >
                      ⋮⋮
                    </button>
                    <button
                      className="project-head"
                      onClick={() => toggleProject(g.cwd, open)}
                      title={g.cwd}
                    >
                      <span className="chev">{open ? "▾" : "▸"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{g.name}</span>
                    </button>
                    <button
                      type="button"
                      className="project-plus"
                      title="이 프로젝트에 새 세션"
                      onClick={() => void onNewSessionInProject(g.cwd)}
                    >
                      +
                    </button>
                  </div>
                  {open
                    ? g.sessions.map((s) => {
                        const running =
                          busy && activeSession?.id === s.id ||
                          agentThreads.some((t) => t.sessionId === s.id && t.state === "running") ||
                          !!cacheRef.current[threadKey(g.cwd, s.id)]?.busy;
                        return (
                        <div
                          key={s.id}
                          className={`thread-row ${activeSession?.id === s.id ? "active" : ""} ${running ? "running" : ""}`}
                          title={running ? "실행 중" : "대기"}
                        >
                          {running ? <span className="thread-run-dot" title="실행 중" /> : null}
                          <button
                            className="thread-item"
                            title={running ? `실행 중 · ${s.title}` : s.title}
                            onClick={() => void openSession(g, s)}
                          >
                            {s.title}
                          </button>
                          <button
                            type="button"
                            className="thread-del"
                            title="세션 삭제"
                            onClick={(e) => void onDeleteSession(g.cwd, s.id, e)}
                          >
                            ×
                          </button>
                        </div>
                        );
                      })
                    : null}
                </div>
              );
            })
          )}
        </div>

        <div className="sidebar-footer">
          <div className="user-chip">
            <div className="user-avatar" />
            <span>{authLabel}</span>
          </div>
          {auth.state === "authenticated" ? (
            <button className="btn btn-ghost" style={{ padding: "4px 8px", fontSize: 12 }} onClick={() => void window.grokDeck.auth.logout().then(setAuth)}>
              로그아웃
            </button>
          ) : (
            <button className="btn btn-primary" style={{ padding: "4px 10px", fontSize: 12 }} disabled={loginBusy} onClick={() => void onLogin()}>
              로그인
            </button>
          )}
        </div>
      </aside>

      <PanelDivider side="left" onDrag={onSidebarDrag} onDragEnd={persistPanelWidths} />

      {/* ── Center: conversation ── */}
      <main className="main">
        <div className="main-header">
          <div className="thread-title">
            <span className={`dot ${agentDot}`} />
            <span>{title}</span>
          </div>
          <div className="header-actions">
            {lastTurnMs != null ? (
              <span className="turn-timer">{formatDuration(lastTurnMs)} 동안 작업</span>
            ) : busy ? (
              <span className="turn-timer live">작업 중…</span>
            ) : null}
            <div className="open-menu-wrap">
              <button
                className="btn btn-sm"
                disabled={!project.root}
                onClick={() => setOpenMenu((v) => !v)}
                title="프로젝트 외부에서 열기"
              >
                열기 ▾
              </button>
              {openMenu ? (
                <div className="open-menu">
                  <button type="button" onClick={() => void openExternal("explorer")}>
                    탐색기
                  </button>
                  <button type="button" onClick={() => void openExternal("powershell")}>
                    PowerShell
                  </button>
                  <button type="button" onClick={() => void openExternal("cmd")}>
                    CMD
                  </button>
                  <button type="button" onClick={() => void openExternal("vscode")}>
                    VS Code
                  </button>
                  <button type="button" onClick={() => void openExternal("cursor")}>
                    Cursor
                  </button>
                </div>
              ) : null}
            </div>
            <button
              className={`mode-chip ${mode}`}
              title={deckModeHint(mode)}
              onClick={() => void cycleMode()}
            >
              {deckModeLabel(mode)}
              <span className="hotkey">⇧Tab</span>
            </button>
            <span className="status-line">{statusLine}</span>
          </div>
        </div>

        <div
          className="chat"
          ref={chatRef}
          onScroll={() => {
            if (ignoreScrollRef.current) return;
            const el = chatRef.current;
            if (!el) return;
            stickToBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          onWheel={() => {
            const el = chatRef.current;
            if (!el) return;
            stickToBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 140;
          }}
          onMouseDown={() => {
            selectingRef.current = true;
          }}
          onMouseUp={() => {
            selectingRef.current = false;
          }}
        >
          <div className="chat-inner" ref={chatInnerRef}>
          {loadingHistory ? (
            <div className="empty-hero">
              <p className="muted">대화 불러오는 중…</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="empty-hero">
              <h2>무엇을 만들까요?</h2>
              <p>
                Codex처럼 프로젝트·스레드가 왼쪽, 대화가 가운데, 변경/리뷰가 오른쪽에 있습니다.
                이전 Grok CLI 세션도 왼쪽 목록에서 다시 열 수 있습니다.
              </p>
              <div className="hero-actions">
                {auth.state !== "authenticated" ? (
                  <button className="btn btn-primary" onClick={() => void onLogin()}>
                    Grok 로그인
                  </button>
                ) : null}
                <button className="btn" onClick={() => void onOpenProject()}>
                  프로젝트 열기
                </button>
                <button className="btn" onClick={() => setNewProjectOpen(true)}>
                  새 작업
                </button>
              </div>
              <p className="muted" style={{ marginTop: 18 }}>
                <kbd>Shift+Tab</kbd> 모드 · <kbd>Ctrl+N</kbd> 새 프로젝트 · <kbd>Ctrl+Enter</kbd>{" "}
                전송
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                live={busy && m.id === liveMessageId}
                onReview={focusReview}
                onUndo={() => void onGhostUndo()}
                canUndo={
                  ghost.canUndo &&
                  !!m.editSummary &&
                  (!!ghost.last?.id
                    ? ghost.last.id === m.editSummary.ghostCommitId
                    : true)
                }
                undoing={undoing}
                projectRoot={project.root}
              />
            ))
          )}
          </div>
        </div>

        {permission ? (
          <div className="perm-banner">
            <div className="kicker">
              권한 요청 · {permission.source === "client_fs" ? "파일 쓰기" : "도구"}
              {permissionQueue.length > 1 ? ` · +${permissionQueue.length - 1}` : ""}
            </div>
            <h3>{permission.title}</h3>
            {permission.path ? <div className="path">{permission.path}</div> : null}
            {permission.toolCall?.diffs?.[0] ? (
              <pre className="diff-pre">{unifiedDiffPreview(permission.toolCall.diffs[0])}</pre>
            ) : permission.detail ? (
              <pre className="diff-pre">{permission.detail}</pre>
            ) : null}
            <div className="perm-actions">
              {(permission.options.length
                ? permission.options
                : [
                    { optionId: "allow-once", name: "허용" },
                    { optionId: "reject-once", name: "거부" },
                  ]
              ).map((opt) => {
                const reject =
                  opt.optionId.includes("reject") ||
                  opt.kind?.includes("reject") ||
                  opt.optionId === "cancel";
                return (
                  <button
                    key={opt.optionId}
                    className={reject ? "btn btn-danger" : "btn btn-primary"}
                    onClick={() => void onPermission(opt.optionId)}
                  >
                    {opt.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <QueueBar
          items={queue}
          busy={busy}
          onEdit={editQueued}
          onRemove={removeQueued}
          onRun={runQueued}
        />

        {activePlan && !planDismissed && (mode === "plan" || mode === "normal") ? (
          <PlanReviewCard
            plan={activePlan}
            busy={busy}
            onImplement={(notes) => void onImplementPlan(notes)}
            onRevise={(notes) => void onRevisePlan(notes)}
            onDismiss={() => setPlanDismissed(true)}
          />
        ) : null}

        <Composer
          busy={busy}
          canType={auth.state === "authenticated"}
          authReady={auth.state === "authenticated"}
          projectRoot={project.root}
          mode={mode}
          settings={settings}
          slashCmds={slashCmds}
          onSubmit={(text, atts) => void handleSubmit(text, atts)}
          onCancel={() => void onCancelTurn()}
          onCycleMode={() => void cycleMode()}
          onSetEffort={(effort) => void setEffort(effort)}
          onSetTheme={(theme) => void setTheme(theme)}
          onRunSlash={(cmd) => void runSlash(cmd)}
          onStatus={setStatusLine}
          onQueue={enqueueMessage}
          seedText={draftSeedText}
          seedNonce={draftSeed}
        />

      </main>

      <PanelDivider side="right" onDrag={onRightDrag} onDragEnd={persistPanelWidths} />

      {/* ── Right: environment / review ── */}
      <aside className="rightbar">
        <div className="right-section">
          <h4>
            환경 <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>+</span>
          </h4>
          <ContextMeter
            usage={usage}
            estimatedTokens={estimatedTokens}
            liveExtra={liveExtra}
            live={busy}
            compact={compact}
            baseline={usageBaselineRef.current}
          />
          <div className="env-row">
            <span className="icon"> cons</span>
            변경 사항
            {totalStats.count > 0 ? (
              <span style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 12 }}>
                <span style={{ color: "var(--green)" }}>+{totalStats.add}</span>{" "}
                <span style={{ color: "var(--red)" }}>-{totalStats.del}</span>
              </span>
            ) : (
              <span className="muted" style={{ marginLeft: "auto" }}>
                없음
              </span>
            )}
          </div>
          <div className="env-row">
            <span className="icon">💻</span>
            로컬
          </div>
          <div className="env-row">
            <span className="icon">⑂</span>
            {project.root ? shortPath(project.root) : "—"}
          </div>
          <div className="env-row">
            <span className="icon">◎</span>
            {auth.state === "authenticated" ? "OAuth · SuperGrok" : "로그인 필요"}
          </div>
          <div className="env-row">
            <span className="icon">👻</span>
            Ghost Git
            <span className="muted" style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 11 }}>
              {ghost.depth > 0 ? `${ghost.depth} commits` : "empty"}
            </span>
          </div>
          {ghost.canUndo ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{ width: "100%", marginTop: 8 }}
              disabled={undoing}
              onClick={() => void onGhostUndo()}
            >
              {undoing ? "되돌리는 중…" : "실행 취소 (Ghost)"}
            </button>
          ) : null}
          {project.root ? (
            <div className="open-external-grid">
              <button type="button" className="btn btn-sm" onClick={() => void openExternal("explorer")}>
                탐색기
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void openExternal("powershell")}>
                PS
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void openExternal("cmd")}>
                CMD
              </button>
              <button type="button" className="btn btn-sm" onClick={() => void openExternal("vscode")}>
                VS Code
              </button>
            </div>
          ) : null}
        </div>

        <div className="right-scroll">
          {(() => {
            const steps =
              activePlan?.entries?.length
                ? activePlan.entries
                : [...messages]
                    .reverse()
                    .find((m) => m.role === "assistant" && m.plan?.length)?.plan;
            return steps?.length ? (
              <div className="right-section">
                <PlanStepsPanel entries={steps} title="현재 작업 단계" />
              </div>
            ) : null;
          })()}
          <div className="right-section">
            <h4>리뷰 · Diff</h4>
            {fileList.length === 0 ? (
              <p className="muted">에이전트가 수정한 파일이 여기에 표시됩니다.</p>
            ) : (
              <div className="stack">
                {fileList.map((p) => {
                  const d = changedFiles.get(p)!;
                  const s = relativeDiffStats(d);
                  return (
                    <button
                      key={p}
                      className={`file-item ${selectedDiff === p ? "active" : ""}`}
                      onClick={() => setSelectedDiff(p)}
                    >
                      {fileName(p)}{" "}
                      <span style={{ float: "right" }}>
                        <span style={{ color: "var(--green)" }}>+{s.add}</span>{" "}
                        <span style={{ color: "var(--red)" }}>-{s.del}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {activeDiff ? (
              <div className="diff-panel">
                <div className="path">{activeDiff.path}</div>
                <pre className="diff-pre">{unifiedDiffPreview(activeDiff, 100)}</pre>
              </div>
            ) : null}
          </div>

          <div className="right-section">
            <h4>세션</h4>
            <p className="muted" style={{ margin: 0 }}>
              {activeSession
                ? `${activeSession.id.slice(0, 8)}… · ${activeSession.modelId || settings.model}`
                : agentStatus.state === "ready" && "sessionId" in agentStatus
                  ? `${agentStatus.sessionId.slice(0, 8)}…`
                  : "활성 세션 없음"}
            </p>
          </div>

          <div className="right-section">
            <h4>최근 도구</h4>
            <ToolSidebar messages={messages} />
          </div>
        </div>
      </aside>

      {newProjectOpen ? (
        <div className="modal-backdrop" onClick={() => !creatingProject && setNewProjectOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>새 프로젝트</h3>
            <p className="muted">
              Documents 아래에 폴더를 만들고 그 경로에서 세션을 시작합니다.
            </p>
            <div className="field">
              <label>프로젝트 이름</label>
              <input
                autoFocus
                placeholder="예: my-app"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCreateProject();
                  if (e.key === "Escape") setNewProjectOpen(false);
                }}
              />
            </div>
            <p className="muted path-preview">
              {`${typeof navigator !== "undefined" ? "" : ""}~/Documents/${newProjectName.trim() || "…"}`}
            </p>
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
              <button
                type="button"
                className="btn"
                disabled={creatingProject}
                onClick={() => setNewProjectOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={creatingProject || !newProjectName.trim()}
                onClick={() => void onCreateProject()}
              >
                {creatingProject ? "생성 중…" : "만들고 시작"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const MessageView = memo(function MessageView({
  message,
  live = false,
  onReview,
  onUndo,
  canUndo = false,
  undoing = false,
  projectRoot,
}: {
  message: ChatMessage;
  live?: boolean;
  onReview?: (path?: string) => void;
  onUndo?: () => void;
  canUndo?: boolean;
  undoing?: boolean;
  projectRoot?: string | null;
}) {
  if (message.role === "user") {
    const atts = message.attachments || [];
    return (
      <div className="msg user">
        {atts.length > 0 ? (
          <div className="msg-attachments">
            {atts.map((a) => (
              <div key={a.id} className={`msg-attach ${a.kind}`}>
                {a.kind === "image" && a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} className="msg-attach-img" />
                ) : (
                  <div className="msg-attach-file">
                    <span>📄</span>
                    <span className="msg-attach-name" title={a.path}>
                      {a.name}
                    </span>
                  </div>
                )}
                {a.kind === "image" ? (
                  <span className="msg-attach-caption" title={a.path}>
                    {a.name}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {message.content ? (
          <div className="bubble">
            <Markdown
              text={message.content}
              projectRoot={projectRoot}
              onStatus={emitDeckStatus}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="msg system">
        <div className="body">{message.content}</div>
      </div>
    );
  }

  const tools = message.toolCalls || [];
  const editTools = tools.filter(isEditTool);
  const otherTools = tools.filter((t) => !isEditTool(t));
  const editSummary = message.editSummary;
  const hasEdits = !!editSummary?.files?.length || editTools.length > 0;
  // While live: show compact chips for in-flight tools under text
  // After done: edits go to summary card; other tools collapse into a group

  return (
    <div className="msg assistant">
      {message.durationMs != null && !live ? (
        <div className="turn-meta">{formatDuration(message.durationMs)} 동안 작업</div>
      ) : null}

      {message.content ? (
        <Markdown
          text={message.content}
          projectRoot={projectRoot}
          onStatus={emitDeckStatus}
        />
      ) : null}

      {message.thoughts ? (
        <details className="thought-box">
          <summary>Thinking</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{message.thoughts}</div>
        </details>
      ) : null}

      {message.plan?.length ? (
        <details className="plan-box" open>
          <summary>
            <strong>Plan</strong>
            <span className="plan-box-meta">{message.plan.length} steps · 펼치기/접기</span>
          </summary>
          <ol>
            {message.plan.map((p, i) => (
              <li key={i}>
                {p.content}
                {p.status ? ` · ${p.status}` : ""}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {/* Live tools: collapsed toast so assistant text stays visible */}
      {live && tools.length > 0 ? <LiveToolToast tools={tools} /> : null}

      {/* Finished turn: per-message file edit summary + collapsed other tools */}
      {!live ? (
        <>
          {hasEdits ? (
            <EditSummaryCard
              tools={editTools}
              files={
                editSummary?.files?.length
                  ? editSummary.files
                  : editFilesFromTools(tools)
              }
              onReview={onReview}
              onUndo={onUndo}
              canUndo={canUndo}
              undoing={undoing}
            />
          ) : null}
          {otherTools.length > 0 ? (
            <ToolGroup tools={otherTools} defaultCollapsed />
          ) : null}
          {/* Safety: if only edit tools with no summary classification, still show group collapsed */}
          {!hasEdits && editTools.length > 0 ? (
            <ToolGroup tools={editTools} label="파일 편집" defaultCollapsed />
          ) : null}
        </>
      ) : null}
    </div>
  );
}, (prev, next) => {
  if (prev.live || next.live) return false;
  return (
    prev.message === next.message &&
    prev.live === next.live &&
    prev.canUndo === next.canUndo &&
    prev.undoing === next.undoing &&
    prev.projectRoot === next.projectRoot
  );
});

function ToolSidebar({ messages }: { messages: ChatMessage[] }) {
  const tools: ToolCallView[] = [];
  const seen = new Set<string>();
  // Newest message first, and within a turn the last-invoked tool first.
  for (let i = messages.length - 1; i >= 0 && tools.length < 12; i--) {
    const calls = messages[i]?.toolCalls;
    if (!calls?.length) continue;
    for (let j = calls.length - 1; j >= 0 && tools.length < 12; j--) {
      const t = calls[j];
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tools.push(t);
    }
  }
  if (!tools.length) return <p className="muted">도구 호출이 여기 표시됩니다.</p>;
  return (
    <div className="stack recent-tools">
      {tools.map((t) => (
        <ToolChip key={t.id} tool={t} />
      ))}
    </div>
  );
}
