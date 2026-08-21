/** Shared IPC / UI event types for Grok Deck */

export type AuthStatus =
  | { state: "unknown" }
  | { state: "authenticated"; email?: string; userId?: string; expiresAt?: string }
  | { state: "unauthenticated" }
  | { state: "error"; message: string };

/** CLI Shift+Tab cycle: Normal → Plan → Always-approve */
export type DeckMode = "normal" | "plan" | "yolo";

export const DECK_MODES: DeckMode[] = ["normal", "plan", "yolo"];

export function nextDeckMode(current: DeckMode): DeckMode {
  const i = DECK_MODES.indexOf(current);
  return DECK_MODES[(i + 1) % DECK_MODES.length]!;
}

export function deckModeLabel(mode: DeckMode): string {
  switch (mode) {
    case "normal":
      return "Normal";
    case "plan":
      return "Plan";
    case "yolo":
      return "Always-approve";
  }
}

export function deckModeHint(mode: DeckMode): string {
  switch (mode) {
    case "normal":
      return "Ask before edits & shell (Shift+Tab to cycle)";
    case "plan":
      return "Plan only — project writes blocked; any plan.md allowed (Shift+Tab)";
    case "yolo":
      return "Auto-approve tools (Shift+Tab / Ctrl+O)";
  }
}

/** Grok reasoning effort (CLI --reasoning-effort) */
export type ReasoningEffort = "low" | "medium" | "high";

export const REASONING_EFFORTS: Array<{
  id: ReasoningEffort;
  label: string;
  description: string;
}> = [
  { id: "low", label: "낮음 (Low)", description: "빠른 구현" },
  { id: "medium", label: "중간 (Medium)", description: "균형" },
  { id: "high", label: "높음 (High)", description: "최고 품질 추론" },
];

export type BuiltinThemeId = "dark" | "ember" | "night" | "aurora";
/** Built-in theme id or `custom:<id>` for user-imported wallpapers */
export type ThemeId = BuiltinThemeId | `custom:${string}`;

export const THEMES: Array<{
  id: BuiltinThemeId;
  label: string;
  wallpaper?: string;
  defaultOpacity: number;
}> = [
  { id: "dark", label: "다크 (순정)", defaultOpacity: 0 },
  { id: "ember", label: "엠버", wallpaper: "wallpaper-ember.jpg", defaultOpacity: 0.22 },
  { id: "night", label: "나이트", wallpaper: "wallpaper-night.jpg", defaultOpacity: 0.2 },
  { id: "aurora", label: "오로라", wallpaper: "wallpaper-aurora.jpg", defaultOpacity: 0.2 },
];

export type CustomThemeInfo = {
  id: string;
  label: string;
  file: string;
  prompt?: string;
  createdAt: string;
  source?: string;
};

export function isCustomThemeId(id: string): id is `custom:${string}` {
  return id.startsWith("custom:");
}

export function customThemeKey(id: string): string {
  return id.startsWith("custom:") ? id.slice("custom:".length) : id;
}

export type ChatRole = "user" | "assistant" | "system";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

export interface FileDiff {
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface ToolCallView {
  id: string;
  title?: string;
  kind?: string;
  tool?: string;
  status: ToolCallStatus;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  locations?: Array<{ path: string; line?: number }>;
  diffs?: FileDiff[];
}

export interface PlanEntry {
  content: string;
  status?: string;
  priority?: string;
}

/** Latest plan document the UI can review / implement (Codex-style). */
export interface PlanDocument {
  path: string;
  content: string;
  entries?: PlanEntry[];
  updatedAt: number;
}

export type PermissionSource = "agent" | "client_fs" | "client_shell";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  contextLimit?: number;
  /** Unix ms when /compact last succeeded for this workspace */
  compactedAt?: number;
  /** Token count immediately before the last compact */
  tokensBeforeCompact?: number;
}

export interface GhostFileStat {
  path: string;
  /** Lines added in this turn only */
  add: number;
  /** Lines removed in this turn only */
  del: number;
}

export interface GhostCommitInfo {
  id: string;
  createdAt: number;
  message: string;
  fileCount: number;
  paths?: string[];
  /** Per-file line stats for this turn (not cumulative) */
  files?: GhostFileStat[];
}

export interface GhostStatus {
  canUndo: boolean;
  depth: number;
  last?: { id: string; createdAt: number; message: string; fileCount: number };
}

/** Attached to an assistant message after a turn that wrote files */
export interface MessageEditSummary {
  ghostCommitId: string;
  files: GhostFileStat[];
}

export interface SlashCommand {
  name: string;
  description: string;
  hint?: string;
  /** command = slash builtin/agent; skill = SKILL.md package */
  kind?: "command" | "skill";
  source?: string;
}

/** File/image attached to a chat turn (composer + message bubble). */
export interface ChatAttachment {
  id: string;
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  size?: number;
  /** data: URL for image preview in the UI */
  previewUrl?: string;
}

/** Payload sent with agent.prompt (main process expands to ACP content blocks). */
export interface PromptAttachmentRef {
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
}

/** Renderer → main: clipboard image (screenshot / Ctrl+V). `data` is raw base64. */
export interface ClipboardImagePayload {
  mimeType: string;
  data: string;
  name?: string;
}

export interface PromptRequest {
  text: string;
  attachments?: PromptAttachmentRef[];
  sessionId?: string;
  cwd?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface ThreadSnapshot {
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  queue: QueuedMessage[];
  updatedAt: number;
}

export interface AgentThreadInfo {
  cwd: string;
  sessionId: string;
  state: "idle" | "starting" | "ready" | "running" | "error";
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "user" | "bundled" | "project" | "commands";
  path: string;
}

export interface WorkspaceFileEntry {
  path: string;
  relative: string;
  name: string;
  isDir?: boolean;
}

type SessionTag = { sessionId?: string; cwd?: string };

type StreamEventBody =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool_call"; call: ToolCallView }
  | { type: "tool_call_update"; call: Partial<ToolCallView> & { id: string } }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "plan_document"; plan: PlanDocument }
  | {
      type: "permission_request";
      requestId: number;
      source: PermissionSource;
      title: string;
      detail?: string;
      toolCall?: ToolCallView;
      options: PermissionOption[];
      path?: string;
    }
  | { type: "file_changed"; path: string; action: "read" | "write"; bytes?: number }
  | { type: "diff"; diff: FileDiff }
  | { type: "mode"; mode: DeckMode }
  | { type: "usage"; usage: TokenUsage }
  | { type: "context_limit"; limit: number }
  | {
      type: "compact";
      status: "started" | "done" | "failed";
      before?: number;
      after?: number;
      message?: string;
      usage?: TokenUsage;
    }
  | { type: "ghost_commit"; commit: GhostCommitInfo }
  | { type: "ghost_undo"; commit: GhostCommitInfo }
  | { type: "ghost_status"; ghost: GhostStatus }
  | { type: "commands"; commands: SlashCommand[] }
  | {
      type: "turn_done";
      stopReason?: string;
      usage?: TokenUsage;
      durationMs?: number;
      ghost?: GhostStatus;
    }
  | { type: "error"; message: string }
  | { type: "status"; message: string };

export type StreamEvent = StreamEventBody & SessionTag;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thoughts?: string;
  toolCalls?: ToolCallView[];
  plan?: PlanEntry[];
  createdAt: number;
  durationMs?: number;
  /** Per-turn file edit summary (from Ghost Git commit) */
  editSummary?: MessageEditSummary;
  /** User-attached images/files for this message */
  attachments?: ChatAttachment[];
}

export interface ProjectState {
  root: string | null;
  recent: string[];
}

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActiveAt?: string;
  modelId?: string;
  numMessages?: number;
}

export interface ProjectGroup {
  cwd: string;
  name: string;
  sessions: SessionSummary[];
}

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface AppSettings {
  model: string;
  deckMode: DeckMode;
  grokPath: string;
  reasoningEffort: ReasoningEffort;
  theme: ThemeId;
  /** 0–0.45 wallpaper strength behind chat */
  wallpaperOpacity: number;
  windowBounds?: WindowBounds;
  /** When theme is custom:*, points at CustomThemeInfo.id */
  customThemeId?: string;
  /** Left sidebar width in px */
  sidebarWidth?: number;
  /** Right review panel width in px */
  rightWidth?: number;
  /** User-defined project list order (cwd paths) */
  projectOrder?: string[];
  /** Sidebar project expand state keyed by cwd. Missing key = expanded. */
  sidebarExpanded?: Record<string, boolean>;
  /** Windows toast when a turn finishes (and the window is in the background). */
  notifyMessage?: boolean;
  /** Play a chime when a turn finishes. */
  notifySound?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  model: "grok-4.5",
  deckMode: "normal",
  grokPath: "grok",
  reasoningEffort: "high",
  theme: "ember",
  wallpaperOpacity: 0.22,
  sidebarWidth: 260,
  rightWidth: 300,
  projectOrder: [],
  sidebarExpanded: {},
  notifyMessage: true,
  notifySound: true,
};

export const PANEL_LIMITS = {
  sidebarMin: 180,
  sidebarMax: 420,
  rightMin: 220,
  rightMax: 480,
} as const;

export type OpenExternalTarget = "explorer" | "powershell" | "cmd" | "vscode" | "cursor";

/** Built-in slash commands we always surface (CLI parity helpers) */
export const BUILTIN_SLASH: SlashCommand[] = [
  { name: "compact", description: "대화 압축 (컨텍스트 절약)", hint: "optional focus" },
  { name: "context", description: "컨텍스트 사용량 보기" },
  { name: "session-info", description: "세션 정보" },
  { name: "always-approve", description: "Always-approve 토글", hint: "on|off" },
  { name: "new", description: "새 세션 (UI에서 처리)" },
  { name: "clear", description: "대화 비우기 (UI)" },
  { name: "help", description: "도움말 / 명령 목록" },
];

export const IpcChannels = {
  appGetVersion: "app:get-version",
  appNotify: "app:notify",
  authGetStatus: "auth:get-status",
  authLogin: "auth:login",
  authLogout: "auth:logout",
  projectOpen: "project:open",
  projectGet: "project:get",
  projectOpenExternal: "project:open-external",
  shellOpenPath: "shell:open-path",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  sessionsList: "sessions:list",
  sessionsTranscript: "sessions:transcript",
  sessionsDelete: "sessions:delete",
  threadGet: "thread:get",
  threadSet: "thread:set",
  agentThreads: "agent:threads",
  projectCreate: "project:create",
  themesList: "themes:list",
  themesImportFile: "themes:import-file",
  themesImportPath: "themes:import-path",
  themesImportLatest: "themes:import-latest",
  themesDelete: "themes:delete",
  themesGenerate: "themes:generate",
  themesRecent: "themes:recent",
  themesDataUrl: "themes:data-url",
  agentStart: "agent:start",
  agentStop: "agent:stop",
  agentPrompt: "agent:prompt",
  agentCancel: "agent:cancel",
  agentRespondPermission: "agent:respond-permission",
  agentSetMode: "agent:set-mode",
  agentGetMode: "agent:get-mode",
  agentLoadSession: "agent:load-session",
  agentSetEffort: "agent:set-effort",
  agentGetCommands: "agent:get-commands",
  agentGetPlan: "agent:get-plan",
  agentEvent: "agent:event",
  agentStatus: "agent:status",
  ghostUndo: "ghost:undo",
  ghostStatus: "ghost:status",
  attachmentsPick: "attachments:pick",
  attachmentsFromPaths: "attachments:from-paths",
  attachmentsFromData: "attachments:from-data",
  skillsList: "skills:list",
  workspaceSearchFiles: "workspace:search-files",
} as const;

export type AgentRuntimeStatus =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "ready"; sessionId: string; cwd: string; mode: DeckMode }
  | { state: "running"; sessionId: string; mode: DeckMode }
  | { state: "error"; message: string };

export function isEditTool(t: ToolCallView): boolean {
  // Diffs are the strongest signal (agent write / fs write)
  if (t.diffs && t.diffs.length > 0) return true;
  const kind = (t.kind || "").toLowerCase();
  if (["edit", "delete", "move"].includes(kind)) return true;
  const title = `${t.title || ""} ${t.tool || ""}`.toLowerCase();
  return /write|edit|search_replace|apply_patch|create_file|delete_file|str_replace|write_text_file|fs\/write/.test(
    title,
  );
}

export function formatTokenCount(n?: number): string {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatDuration(ms?: number): string {
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
