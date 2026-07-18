import {
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
  ProjectGroup,
  ProjectState,
  SessionSummary,
  StreamEvent,
  ToolCallView,
  WorkspaceFileEntry,
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
import { Markdown } from "./components/Markdown";
import { ToolChip, ToolGroup } from "./components/ToolChip";
import { EditSummaryCard } from "./components/EditSummaryCard";
import { ContextMeter } from "./components/ContextMeter";
import { ResizeHandles } from "./components/ResizeHandles";
import { PanelDivider } from "./components/PanelDivider";

function uid(prefix = "m") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
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
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionHits, setMentionHits] = useState<WorkspaceFileEntry[]>([]);
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
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
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

  const chatRef = useRef<HTMLDivElement>(null);
  const streamingId = useRef<string | null>(null);
  const turnStartRef = useRef<number | null>(null);

  const permission = permissionQueue[0] ?? null;

  const refreshSessions = useCallback(async () => {
    const list = await window.grokDeck.sessions.list(showNoiseSessions);
    setProjects(list);
    setExpanded((prev) => {
      const next = { ...prev };
      for (const g of list) {
        if (next[g.cwd] === undefined) next[g.cwd] = true;
      }
      return next;
    });
  }, [showNoiseSessions]);

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
    const offStatus = window.grokDeck.agent.onStatus((status) => {
      setAgentStatus(status);
      if ("mode" in status && status.mode) setMode(status.mode);
      if (status.state === "ready") {
        setStatusLine(`Ready · ${shortPath(status.cwd)}`);
        // Agent restart recreates GhostGit in memory — reload disk history for UI
        void window.grokDeck.ghost.status().then(setGhost);
      }
      if (status.state === "running") setStatusLine("Working…");
      if (status.state === "error") setStatusLine(status.message);
      if (status.state === "idle") setStatusLine("Idle");
      if (status.state === "starting") setStatusLine("Starting…");
    });
    return () => {
      offEvent();
      offStatus();
    };
  }, []);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, permissionQueue, loadingHistory]);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, project.root]);

  function ensureAssistantMessage(): string {
    if (streamingId.current) return streamingId.current;
    const id = uid("a");
    streamingId.current = id;
    setMessages((prev) => [
      ...prev,
      { id, role: "assistant", content: "", thoughts: "", toolCalls: [], createdAt: Date.now() },
    ]);
    return id;
  }

  function patchAssistant(id: string, patch: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }

  function handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case "text": {
        const id = ensureAssistantMessage();
        patchAssistant(id, (m) => ({ ...m, content: m.content + event.text }));
        break;
      }
      case "thought": {
        const id = ensureAssistantMessage();
        patchAssistant(id, (m) => ({ ...m, thoughts: (m.thoughts || "") + event.text }));
        break;
      }
      case "tool_call": {
        const id = ensureAssistantMessage();
        patchAssistant(id, (m) => ({
          ...m,
          toolCalls: [...(m.toolCalls || []).filter((t) => t.id !== event.call.id), event.call],
        }));
        break;
      }
      case "tool_call_update": {
        const id = ensureAssistantMessage();
        patchAssistant(id, (m) => ({
          ...m,
          toolCalls: (m.toolCalls || []).map((t) =>
            t.id === event.call.id ? { ...t, ...event.call, diffs: event.call.diffs || t.diffs } : t,
          ),
        }));
        break;
      }
      case "plan": {
        const id = ensureAssistantMessage();
        patchAssistant(id, (m) => ({ ...m, plan: event.entries }));
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
        }));
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
        // Attach per-turn edit summary to the live assistant message
        const files =
          event.commit.files && event.commit.files.length > 0
            ? event.commit.files
            : (event.commit.paths || []).map((path) => ({ path, add: 0, del: 0 }));
        const targetId = streamingId.current;
        if (targetId && files.length > 0) {
          patchAssistant(targetId, (m) => ({
            ...m,
            editSummary: {
              ghostCommitId: event.commit.id,
              files,
            },
          }));
        } else if (files.length > 0) {
          // Turn already closed streaming id — attach to last assistant message
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i]?.role === "assistant") {
                next[i] = {
                  ...next[i]!,
                  editSummary: {
                    ghostCommitId: event.commit.id,
                    files,
                  },
                };
                break;
              }
            }
            return next;
          });
        }
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
        setBusy(false);
        const duration =
          event.durationMs ??
          (turnStartRef.current ? Date.now() - turnStartRef.current : undefined);
        turnStartRef.current = null;
        if (duration != null) setLastTurnMs(duration);
        if (event.usage) {
          setUsage((prev) => ({
            ...(prev || {}),
            ...event.usage,
            totalTokens: event.usage!.totalTokens ?? prev?.totalTokens,
            inputTokens: event.usage!.inputTokens ?? prev?.inputTokens,
            outputTokens: event.usage!.outputTokens ?? prev?.outputTokens,
            contextLimit: event.usage!.contextLimit ?? prev?.contextLimit,
          }));
        }
        if (event.ghost) setGhost(event.ghost);
        if (streamingId.current && duration != null) {
          const id = streamingId.current;
          patchAssistant(id, (m) => ({ ...m, durationMs: duration }));
        }
        streamingId.current = null;
        setStatusLine(
          event.stopReason
            ? `Done · ${event.stopReason}${duration ? ` · ${formatDuration(duration)}` : ""}`
            : duration
              ? `Done · ${formatDuration(duration)}`
              : "Done",
        );
        void refreshSessions();
        void window.grokDeck.ghost.status().then(setGhost);
        break;
      }
      case "error":
        setBusy(false);
        streamingId.current = null;
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
      setActiveSession(null);
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
    const root = cwd || project.root;
    if (!root) {
      setNewProjectOpen(true);
      return;
    }
    setMessages([]);
    setChangedFiles(new Map());
    setSelectedDiff(null);
    setPermissionQueue([]);
    setActiveSession(null);
    streamingId.current = null;
    setBusy(false);
    setProject((p) => ({ ...p, root }));
    const st = await window.grokDeck.agent.start(root);
    setAgentStatus(st);
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
      setMessages([]);
      setChangedFiles(new Map());
      setSelectedDiff(null);
      setPermissionQueue([]);
      setActiveSession(null);
      streamingId.current = null;
      setNewProjectOpen(false);
      setNewProjectName("");
      setStatusLine(res.message);
      const st = await window.grokDeck.agent.getStatus();
      setAgentStatus(st);
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
      setActiveSession(null);
      setMessages([]);
    }
    await refreshSessions();
  }

  async function openSession(group: ProjectGroup, session: SessionSummary) {
    setLoadingHistory(true);
    setActiveSession(session);
    setProject({ root: group.cwd, recent: project.recent });
    setChangedFiles(new Map());
    setSelectedDiff(null);
    setPermissionQueue([]);
    streamingId.current = null;
    setBusy(false);

    try {
      const transcript = await window.grokDeck.sessions.transcript(session.id, group.cwd);
      setMessages(
        transcript.map((t) => ({
          ...t,
          toolCalls: t.toolCalls?.map((tc) => ({
            id: tc.id,
            title: tc.title,
            kind: tc.kind,
            status: (tc.status as ToolCallView["status"]) || "completed",
            input: tc.input,
          })),
        })),
      );
      setStatusLine(`Loaded · ${session.title}`);

      // Start/resume agent for this project (history already painted)
      const st = await window.grokDeck.agent.loadSession(group.cwd, session.id);
      setAgentStatus(st);
      if ("mode" in st && st.mode) setMode(st.mode);
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

  function addAttachments(list: ChatAttachment[]) {
    if (!list.length) return;
    setAttachments((prev) => {
      const map = new Map(prev.map((a) => [a.path.toLowerCase(), a]));
      for (const a of list) map.set(a.path.toLowerCase(), a);
      return [...map.values()];
    });
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function onPickAttachments() {
    try {
      const res = await window.grokDeck.attachments.pick();
      if (!res.ok && res.message) setStatusLine(res.message);
      if (res.attachments?.length) {
        addAttachments(res.attachments);
        setStatusLine(`${res.attachments.length}개 파일 첨부`);
      }
    } catch (err) {
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
  }

  function pathsFromFileList(files: FileList | null | undefined): string[] {
    if (!files?.length) return [];
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f) continue;
      const p = window.grokDeck.attachments.pathForFile(f);
      if (p) paths.push(p);
    }
    return paths;
  }

  async function onPasteFiles(e: React.ClipboardEvent) {
    const paths = pathsFromFileList(e.clipboardData?.files);
    if (!paths.length) return;
    e.preventDefault();
    const atts = await window.grokDeck.attachments.fromPaths(paths);
    addAttachments(atts);
  }

  async function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsFromFileList(e.dataTransfer?.files);
    if (!paths.length) return;
    const atts = await window.grokDeck.attachments.fromPaths(paths);
    addAttachments(atts);
  }

  /** Detect trailing @query for file mention autocomplete */
  function updateMentionFromDraft(value: string, caret = value.length) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|[\s\n])@([^\s@]*)$/);
    if (m) {
      setMentionOpen(true);
      setMentionFilter(m[1] || "");
      setSlashOpen(false);
    } else {
      setMentionOpen(false);
      setMentionFilter("");
    }
  }

  useEffect(() => {
    if (!mentionOpen || !project.root) {
      setMentionHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void window.grokDeck.workspace
        .searchFiles(mentionFilter, project.root || undefined)
        .then((hits) => {
          if (!cancelled) setMentionHits(hits);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mentionOpen, mentionFilter, project.root]);

  function insertMention(file: WorkspaceFileEntry) {
    setDraft((prev) => {
      const m = prev.match(/^(.*(?:^|[\s\n]))@([^\s@]*)$/s);
      if (m) {
        return `${m[1]}@${file.relative} `;
      }
      // Replace last @token
      const idx = prev.lastIndexOf("@");
      if (idx >= 0) {
        const afterAt = prev.slice(idx + 1);
        if (!/\s/.test(afterAt)) {
          return `${prev.slice(0, idx)}@${file.relative} `;
        }
      }
      return `${prev}${prev.endsWith(" ") || !prev ? "" : " "}@${file.relative} `;
    });
    setMentionOpen(false);
    // Also attach the file so agent gets resource_link
    void window.grokDeck.attachments.fromPaths([file.path]).then(addAttachments);
  }

  async function onSend() {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
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

    const pendingAtts = [...attachments];
    const displayText = text || (pendingAtts.length ? `(첨부 ${pendingAtts.length}개)` : "");
    setDraft("");
    setAttachments([]);
    setSlashOpen(false);
    setMentionOpen(false);
    setBusy(true);
    streamingId.current = null;
    turnStartRef.current = Date.now();
    setLastTurnMs(null);
    setMessages((prev) => [
      ...prev,
      {
        id: uid("u"),
        role: "user",
        content: displayText,
        createdAt: Date.now(),
        attachments: pendingAtts,
      },
    ]);

    try {
      await window.grokDeck.agent.prompt({
        text: text || "Please review the attached files.",
        attachments: pendingAtts.map((a) => ({
          path: a.path,
          name: a.name,
          kind: a.kind,
          mimeType: a.mimeType,
        })),
      });
    } catch (err) {
      setBusy(false);
      turnStartRef.current = null;
      setStatusLine(err instanceof Error ? err.message : String(err));
    }
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
    setConfigOpen(false);
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

  const filteredSlash = useMemo(() => {
    const q = slashFilter.replace(/^\//, "").toLowerCase();
    if (!q) return slashCmds;
    return slashCmds.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        (c.kind === "skill" && "skill".includes(q)),
    );
  }, [slashCmds, slashFilter]);

  useEffect(() => {
    void refreshSlashCommands();
  }, [project.root, agentStatus.state]);

  async function runSlash(cmd: SlashCommand) {
    setSlashOpen(false);
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
    setDraft("");
    setBusy(true);
    streamingId.current = null;
    turnStartRef.current = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: uid("u"), role: "user", content: `/${cmd.name}`, createdAt: Date.now() },
    ]);
    try {
      if (agentStatus.state === "idle" || agentStatus.state === "error") {
        if (project.root) await window.grokDeck.agent.start(project.root);
      }
      await window.grokDeck.agent.prompt(`/${cmd.name}`);
    } catch (err) {
      setBusy(false);
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
            Grok Deck
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
                        setDraft(`/imagine-video ${aiThemePrompt}`);
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
          {projects.length === 0 ? (
            <p className="muted" style={{ padding: "0 10px" }}>
              <strong>새 작업</strong>으로 Documents 아래 프로젝트를 만들거나, 기존 폴더를 여세요.
            </p>
          ) : (
            projects.map((g) => {
              const open = expanded[g.cwd] !== false;
              return (
                <div className="project-block" key={g.cwd}>
                  <div className="project-head-row">
                    <button
                      className="project-head"
                      onClick={() => setExpanded((e) => ({ ...e, [g.cwd]: !open }))}
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
                    ? g.sessions.map((s) => (
                        <div
                          key={s.id}
                          className={`thread-row ${activeSession?.id === s.id ? "active" : ""}`}
                        >
                          <button
                            className="thread-item"
                            title={s.title}
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
                      ))
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

        <div className="chat" ref={chatRef}>
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
                live={busy && m.id === streamingId.current}
                onReview={focusReview}
                onUndo={() => void onGhostUndo()}
                canUndo={
                  ghost.canUndo &&
                  !!m.editSummary &&
                  ghost.last?.id === m.editSummary.ghostCommitId
                }
                undoing={undoing}
                projectRoot={project.root}
              />
            ))
          )}
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

        <div className="composer-wrap">
          <div
            className="composer"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(e) => void onDropFiles(e)}
          >
            {slashOpen ? (
              <div className="slash-menu">
                {filteredSlash.length === 0 ? (
                  <div className="slash-empty">일치하는 명령/스킬 없음</div>
                ) : (
                  filteredSlash.slice(0, 16).map((c) => (
                    <button
                      key={`${c.kind || "cmd"}:${c.name}`}
                      type="button"
                      className="slash-item"
                      onClick={() => void runSlash(c)}
                    >
                      <span className="slash-name">
                        /{c.name}
                        {c.kind === "skill" ? (
                          <span className="slash-badge">skill</span>
                        ) : null}
                      </span>
                      <span className="slash-desc">{c.description}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {mentionOpen ? (
              <div className="slash-menu mention-menu">
                {mentionHits.length === 0 ? (
                  <div className="slash-empty">
                    {project.root ? "파일 없음 · 다른 이름 입력" : "프로젝트를 먼저 여세요"}
                  </div>
                ) : (
                  mentionHits.slice(0, 12).map((f) => (
                    <button
                      key={f.path}
                      type="button"
                      className="slash-item"
                      onClick={() => insertMention(f)}
                    >
                      <span className="slash-name">@{f.name}</span>
                      <span className="slash-desc">{f.relative}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
            {configOpen ? (
              <div className="config-menu">
                <div className="config-section">
                  <div className="config-label">모델</div>
                  <div className="config-row">
                    <strong>{settings.model}</strong>
                  </div>
                </div>
                <div className="config-section">
                  <div className="config-label">추론 강도</div>
                  {REASONING_EFFORTS.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={`config-opt ${settings.reasoningEffort === e.id ? "active" : ""}`}
                      onClick={() => void setEffort(e.id)}
                    >
                      <span>{e.label}</span>
                      {settings.reasoningEffort === e.id ? <span>✓</span> : null}
                    </button>
                  ))}
                </div>
                <div className="config-section">
                  <div className="config-label">테마</div>
                  {THEMES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`config-opt ${settings.theme === t.id ? "active" : ""}`}
                      onClick={() => void setTheme(t.id)}
                    >
                      <span>{t.label}</span>
                      {settings.theme === t.id ? <span>✓</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {attachments.length > 0 ? (
              <div className="attach-strip">
                {attachments.map((a) => (
                  <div key={a.id} className={`attach-chip ${a.kind}`}>
                    {a.kind === "image" && a.previewUrl ? (
                      <img src={a.previewUrl} alt={a.name} className="attach-thumb" />
                    ) : (
                      <span className="attach-file-icon">📄</span>
                    )}
                    <div className="attach-meta">
                      <span className="attach-name" title={a.path}>
                        {a.name}
                      </span>
                      <span className="attach-sub">
                        {a.kind === "image" ? "이미지" : "파일"}
                        {a.size != null ? ` · ${formatBytes(a.size)}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="attach-remove"
                      title="제거"
                      onClick={() => removeAttachment(a.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <textarea
              value={draft}
              placeholder={
                auth.state !== "authenticated"
                  ? "Grok 로그인 후 메시지를 입력하세요…"
                  : project.root
                    ? "메시지 · / 스킬·명령 · @ 파일 멘션 · 클립으로 첨부…"
                    : "프로젝트를 연 뒤 작업을 입력하세요…"
              }
              onChange={(e) => {
                const v = e.target.value;
                setDraft(v);
                const caret = e.target.selectionStart ?? v.length;
                if (v.startsWith("/") && !v.includes("\n")) {
                  setSlashOpen(true);
                  setSlashFilter(v);
                  setConfigOpen(false);
                  setMentionOpen(false);
                } else {
                  setSlashOpen(false);
                  setSlashFilter("");
                  updateMentionFromDraft(v, caret);
                }
              }}
              onPaste={(e) => void onPasteFiles(e)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void onSend();
                }
                if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  void cycleMode();
                }
                if (e.key === "Escape") {
                  setSlashOpen(false);
                  setMentionOpen(false);
                  setConfigOpen(false);
                }
                if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && slashOpen && filteredSlash[0]) {
                  e.preventDefault();
                  void runSlash(filteredSlash[0]);
                }
                if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && mentionOpen && mentionHits[0]) {
                  e.preventDefault();
                  insertMention(mentionHits[0]);
                }
              }}
              disabled={busy && !permission}
            />
            <div className="composer-bar">
              <div className="composer-left">
                <button
                  type="button"
                  className="btn-icon"
                  title="파일 첨부"
                  onClick={() => void onPickAttachments()}
                  disabled={busy}
                >
                  📎
                </button>
                <button
                  type="button"
                  className="config-trigger"
                  onClick={() => {
                    setConfigOpen((v) => !v);
                    setSlashOpen(false);
                    setMentionOpen(false);
                  }}
                >
                  {settings.model} · {settings.reasoningEffort} ▾
                </button>
                <span className="sep">·</span>
                <span>{deckModeLabel(mode)}</span>
              </div>
              <div className="composer-right">
                {busy ? (
                  <button className="btn" onClick={() => void window.grokDeck.agent.cancel()}>
                    취소
                  </button>
                ) : null}
                <button
                  className="btn-send"
                  disabled={busy || (!draft.trim() && attachments.length === 0)}
                  onClick={() => void onSend()}
                  title="Ctrl+Enter"
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      <PanelDivider side="right" onDrag={onRightDrag} onDragEnd={persistPanelWidths} />

      {/* ── Right: environment / review ── */}
      <aside className="rightbar">
        <div className="right-section">
          <h4>
            환경 <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>+</span>
          </h4>
          <ContextMeter usage={usage} />
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

function MessageView({
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
        {message.content ? <div className="bubble">{message.content}</div> : null}
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
          onStatus={(msg) => {
            // bubble via custom event so App status line can show open results
            window.dispatchEvent(new CustomEvent("deck-status", { detail: msg }));
          }}
        />
      ) : null}

      {message.thoughts ? (
        <details className="thought-box">
          <summary>Thinking</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{message.thoughts}</div>
        </details>
      ) : null}

      {message.plan?.length ? (
        <div className="plan-box">
          <strong>Plan</strong>
          <ol>
            {message.plan.map((p, i) => (
              <li key={i}>
                {p.content}
                {p.status ? ` · ${p.status}` : ""}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* Live tools as compact chips (Codex-style) */}
      {live && tools.length > 0 ? (
        <div className="live-tools">
          {tools.map((t) => (
            <ToolChip key={t.id} tool={t} />
          ))}
        </div>
      ) : null}

      {/* Finished turn: per-message file edit summary + collapsed other tools */}
      {!live ? (
        <>
          {hasEdits ? (
            <EditSummaryCard
              tools={editTools}
              files={editSummary?.files}
              onReview={onReview}
              onUndo={onUndo}
              canUndo={canUndo}
              undoing={undoing}
            />
          ) : null}
          {otherTools.length > 0 ? (
            <ToolGroup tools={otherTools} defaultCollapsed />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ToolSidebar({ messages }: { messages: ChatMessage[] }) {
  const tools = [...messages]
    .reverse()
    .flatMap((m) => m.toolCalls || [])
    .slice(0, 10);
  if (!tools.length) return <p className="muted">도구 호출이 여기 표시됩니다.</p>;
  return (
    <div className="stack">
      {tools.map((t) => (
        <ToolChip key={t.id} tool={t} />
      ))}
    </div>
  );
}
