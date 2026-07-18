import { readdir, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type SessionSummary = {
  id: string;
  cwd: string;
  title: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActiveAt?: string;
  modelId?: string;
  numMessages?: number;
  /** True when this looks like a primary user thread (not smoke/noise) */
  isPrimary?: boolean;
  agentName?: string;
  hasTitle?: boolean;
};

export type ProjectGroup = {
  cwd: string;
  name: string;
  sessions: SessionSummary[];
};

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thoughts?: string;
  toolCalls?: Array<{
    id: string;
    title?: string;
    kind?: string;
    status?: string;
    input?: unknown;
  }>;
  createdAt: number;
};

function sessionsRoot(): string {
  return join(homedir(), ".grok", "sessions");
}

function decodeCwdFolder(name: string): string | null {
  try {
    return decodeURIComponent(name);
  } catch {
    return null;
  }
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/**
 * Heuristic: hide smoke tests, empty turns, and likely subagent noise.
 * Primary sessions usually have a generated title and/or real message volume.
 */
export function isPrimarySession(s: SessionSummary): boolean {
  const title = (s.title || "").trim();
  const msgs = s.numMessages ?? 0;
  const agent = (s.agentName || "").toLowerCase();

  // Explicit subagent markers if present in future summaries
  if (agent.includes("subagent") || agent.includes("sub-agent") || agent.includes("child")) {
    return false;
  }
  if (/^subagent\b/i.test(title) || /\(subagent\)/i.test(title)) return false;

  // Empty / near-empty sessions
  if (msgs <= 1 && !s.hasTitle) return false;
  if (msgs === 0) return false;

  // Smoke-test style auto titles
  if (/smoke|terminal create|set-content get-content/i.test(title)) return false;

  // Prefer titled threads, or longer conversations
  if (s.hasTitle && title.length > 2) return true;
  if (msgs >= 6) return true;

  // Untitled short sessions → noise
  if (!s.hasTitle && msgs < 8) return false;

  return true;
}

export async function listProjects(options?: {
  includeNoise?: boolean;
}): Promise<ProjectGroup[]> {
  const root = sessionsRoot();
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const groups: ProjectGroup[] = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.includes("%")) continue;

    const cwd = decodeCwdFolder(ent.name);
    if (!cwd) continue;

    const dir = join(root, ent.name);
    let sessions = await listSessionsInDir(dir, cwd);
    if (!options?.includeNoise) {
      sessions = sessions.filter(isPrimarySession);
    }
    if (sessions.length === 0 && !options?.includeNoise) {
      // Still show project if folder exists as a deck project marker, or has any sessions at all
      const all = await listSessionsInDir(dir, cwd);
      if (all.length === 0) continue;
      // keep empty primary list but surface project only if Documents project
    }
    // Always list if there are primary sessions; if filtering removed all, skip project unless Documents-based
    if (sessions.length === 0) continue;

    sessions.sort((a, b) => {
      const ta = Date.parse(a.lastActiveAt || a.updatedAt || a.createdAt || "0");
      const tb = Date.parse(b.lastActiveAt || b.updatedAt || b.createdAt || "0");
      return tb - ta;
    });

    groups.push({
      cwd,
      name: projectName(cwd),
      sessions,
    });
  }

  // Also include empty projects created by Grok Deck under Documents (marker file)
  const docs = join(homedir(), "Documents");
  if (existsSync(docs)) {
    try {
      const kids = await readdir(docs, { withFileTypes: true });
      for (const k of kids) {
        if (!k.isDirectory()) continue;
        const marker = join(docs, k.name, ".grokdeck-project");
        const legacyMarker = join(docs, k.name, ".grok-deck-project");
        if (!existsSync(marker) && !existsSync(legacyMarker)) continue;
        const cwd = join(docs, k.name);
        if (groups.some((g) => pathsEqual(g.cwd, cwd))) continue;
        groups.unshift({ cwd, name: k.name, sessions: [] });
      }
    } catch {
      /* ignore */
    }
  }

  groups.sort((a, b) => {
    const ta = Date.parse(a.sessions[0]?.lastActiveAt || a.sessions[0]?.updatedAt || "0");
    const tb = Date.parse(b.sessions[0]?.lastActiveAt || b.sessions[0]?.updatedAt || "0");
    return tb - ta;
  });

  return groups;
}

async function listSessionsInDir(dir: string, cwd: string): Promise<SessionSummary[]> {
  const out: SessionSummary[] = [];
  let children: string[] = [];
  try {
    children = await readdir(dir);
  } catch {
    return out;
  }

  for (const id of children) {
    // Skip nested folders that aren't session UUIDs
    if (id === "subagents" || id === "prompt_history.jsonl") continue;
    const summaryPath = join(dir, id, "summary.json");
    if (!existsSync(summaryPath)) continue;
    try {
      const raw = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
      const info = (raw.info || {}) as Record<string, unknown>;
      const generated = (raw.generated_title as string)?.trim();
      const summaryText = (raw.session_summary as string)?.trim();
      const hasTitle = Boolean(generated && generated.length > 0);
      const title =
        generated ||
        summaryText ||
        `Session ${id.slice(0, 8)}`;
      const numMessages =
        (raw.num_chat_messages as number) || (raw.num_messages as number) || 0;
      const s: SessionSummary = {
        id: String(info.id || id),
        cwd: String(info.cwd || cwd),
        title: title.trim() || `Session ${id.slice(0, 8)}`,
        summary: summaryText || undefined,
        createdAt: raw.created_at as string | undefined,
        updatedAt: raw.updated_at as string | undefined,
        lastActiveAt: raw.last_active_at as string | undefined,
        modelId: raw.current_model_id as string | undefined,
        numMessages,
        hasTitle,
        agentName: raw.agent_name as string | undefined,
      };
      s.isPrimary = isPrimarySession(s);
      out.push(s);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function listSessionsForCwd(cwd: string): Promise<SessionSummary[]> {
  const groups = await listProjects({ includeNoise: true });
  const g = groups.find((x) => pathsEqual(x.cwd, cwd));
  return g?.sessions || [];
}

function pathsEqual(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

export async function deleteSession(
  sessionId: string,
  cwd: string,
): Promise<{ ok: boolean; message: string }> {
  const folder = findSessionDir(sessionId, cwd);
  if (!folder) {
    return { ok: false, message: "세션 폴더를 찾을 수 없습니다" };
  }
  try {
    await rm(folder, { recursive: true, force: true });
    return { ok: true, message: "세션이 삭제되었습니다" };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a new project folder under Documents and mark it for Grok Deck.
 */
export async function createProject(
  name: string,
): Promise<{ ok: boolean; cwd?: string; message: string }> {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (!cleaned) {
    return { ok: false, message: "프로젝트 이름을 입력하세요" };
  }

  const docs = join(homedir(), "Documents");
  const cwd = join(docs, cleaned);
  try {
    if (existsSync(cwd)) {
      // Reuse existing folder
      await writeMarker(cwd, cleaned);
      return { ok: true, cwd, message: "기존 폴더를 프로젝트로 엽니다" };
    }
    await mkdir(cwd, { recursive: true });
    await writeMarker(cwd, cleaned);
    // starter README optional
    const readme = join(cwd, "README.md");
    if (!existsSync(readme)) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        readme,
        `# ${cleaned}\n\nCreated with **Grok Deck**.\n`,
        "utf8",
      );
    }
    return { ok: true, cwd, message: `프로젝트 생성: ${cwd}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function writeMarker(cwd: string, name: string) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(cwd, ".grokdeck-project"),
    JSON.stringify({ name, createdAt: new Date().toISOString() }, null, 2),
    "utf8",
  );
}

export async function loadTranscript(sessionId: string, cwd: string): Promise<TranscriptMessage[]> {
  const folder = findSessionDir(sessionId, cwd);
  if (!folder) return [];

  const updatesPath = join(folder, "updates.jsonl");
  if (!existsSync(updatesPath)) return [];

  const raw = await readFile(updatesPath, "utf8");
  const lines = raw.split(/\n/).filter(Boolean);

  type Acc = {
    user: string;
    assistant: string;
    thoughts: string;
    tools: TranscriptMessage["toolCalls"];
  };

  const turns: TranscriptMessage[] = [];
  let acc: Acc = { user: "", assistant: "", thoughts: "", tools: [] };
  let n = 0;

  const flushUser = () => {
    if (!acc.user.trim()) return;
    turns.push({
      id: `u_${n++}`,
      role: "user",
      content: cleanUserText(acc.user),
      createdAt: Date.now(),
    });
    acc.user = "";
  };

  const flushAssistant = () => {
    if (!acc.assistant.trim() && !acc.thoughts.trim() && !(acc.tools && acc.tools.length)) return;
    turns.push({
      id: `a_${n++}`,
      role: "assistant",
      content: acc.assistant,
      thoughts: acc.thoughts || undefined,
      toolCalls: acc.tools?.length ? acc.tools : undefined,
      createdAt: Date.now(),
    });
    acc.assistant = "";
    acc.thoughts = "";
    acc.tools = [];
  };

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const params = (obj.params || obj) as Record<string, unknown>;
    const update = (params.update || obj.update) as Record<string, unknown> | undefined;
    if (!update) continue;
    const kind = update.sessionUpdate as string | undefined;
    if (!kind) continue;

    if (kind === "user_message_chunk") {
      flushAssistant();
      const text = (update.content as { text?: string } | undefined)?.text || "";
      acc.user += text;
    } else if (kind === "agent_message_chunk") {
      flushUser();
      const text = (update.content as { text?: string } | undefined)?.text || "";
      acc.assistant += text;
    } else if (kind === "agent_thought_chunk") {
      flushUser();
      const text = (update.content as { text?: string } | undefined)?.text || "";
      acc.thoughts += text;
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      flushUser();
      const id = String(update.toolCallId || update.id || `tc_${n}`);
      const existing = acc.tools?.find((t) => t.id === id);
      const next = {
        id,
        title: update.title != null ? String(update.title) : existing?.title,
        kind: update.kind != null ? String(update.kind) : existing?.kind,
        status: update.status != null ? String(update.status) : existing?.status,
        input: update.rawInput ?? update.input ?? existing?.input,
      };
      if (existing) Object.assign(existing, next);
      else acc.tools = [...(acc.tools || []), next];
    }
  }

  flushUser();
  flushAssistant();

  return turns.filter((t) => {
    if (t.role === "user") {
      const c = t.content.trim();
      if (!c) return false;
      if (c.startsWith("<system-reminder>") || c.startsWith("<user_info>")) return false;
      if (c.length < 2) return false;
    }
    return true;
  });
}

function cleanUserText(text: string): string {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m?.[1]) return m[1].trim();
  return text
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .trim();
}

function findSessionDir(sessionId: string, cwd: string): string | null {
  const root = sessionsRoot();
  const encoded = encodeURIComponent(cwd);
  const candidate = join(root, encoded, sessionId);
  if (existsSync(join(candidate, "summary.json"))) return candidate;
  return findSessionDirSync(root, sessionId);
}

function findSessionDirSync(root: string, sessionId: string): string | null {
  try {
    for (const name of readdirSync(root)) {
      const p = join(root, name, sessionId);
      if (existsSync(join(p, "summary.json"))) return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function shortProjectLabel(cwd: string): string {
  return projectName(cwd);
}
