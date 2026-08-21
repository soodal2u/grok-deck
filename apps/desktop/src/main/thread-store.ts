import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChatMessage, QueuedMessage, ThreadSnapshot } from "@grok-deck/shared";
import { deckHome, ensureDeckHome } from "./paths";

function threadDir(): string {
  return join(deckHome(), "threads");
}

function snapshotPath(sessionId: string, cwd: string): string {
  const key = `${cwd.replace(/\\/g, "/").toLowerCase()}::${sessionId}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return join(threadDir(), `${hash}.json`);
}

function slimMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    ...m,
    attachments: m.attachments?.map((a) => ({
      ...a,
      previewUrl: a.kind === "image" && a.previewUrl && a.previewUrl.length < 200_000 ? a.previewUrl : undefined,
    })),
  }));
}

export async function loadThreadSnapshot(
  sessionId: string,
  cwd: string,
): Promise<ThreadSnapshot | null> {
  if (!sessionId || !cwd) return null;
  try {
    const raw = await readFile(snapshotPath(sessionId, cwd), "utf8");
    const parsed = JSON.parse(raw) as ThreadSnapshot;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      sessionId,
      cwd,
      messages: parsed.messages,
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      updatedAt: parsed.updatedAt || 0,
    };
  } catch {
    return null;
  }
}

export async function saveThreadSnapshot(snap: ThreadSnapshot): Promise<void> {
  if (!snap?.sessionId || !snap.cwd) return;
  ensureDeckHome();
  const dir = threadDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const payload: ThreadSnapshot = {
    sessionId: snap.sessionId,
    cwd: snap.cwd,
    messages: slimMessages(snap.messages || []),
    queue: snap.queue || [],
    updatedAt: Date.now(),
  };
  await writeFile(snapshotPath(snap.sessionId, snap.cwd), JSON.stringify(payload), "utf8");
}

export async function deleteThreadSnapshot(sessionId: string, cwd: string): Promise<void> {
  try {
    await unlink(snapshotPath(sessionId, cwd));
  } catch {
    /* missing */
  }
}

export function mergeTranscriptWithSnapshot(
  transcript: ChatMessage[],
  snapshot: ThreadSnapshot | null,
): { messages: ChatMessage[]; queue: QueuedMessage[] } {
  if (!snapshot?.messages?.length) {
    return { messages: transcript, queue: snapshot?.queue || [] };
  }
  if (!transcript.length) {
    return { messages: snapshot.messages, queue: snapshot.queue || [] };
  }
  // Prefer snapshot when it has more turns or a live/incomplete assistant tail
  const snapLast = snapshot.messages[snapshot.messages.length - 1];
  const liveTail =
    snapLast?.role === "assistant" &&
    !!snapLast.toolCalls?.some((t) => t.status === "pending" || t.status === "in_progress");
  if (liveTail && snapshot.messages.length >= transcript.length) {
    return { messages: snapshot.messages, queue: snapshot.queue || [] };
  }
  if (snapshot.messages.length > transcript.length) {
    return { messages: snapshot.messages, queue: snapshot.queue || [] };
  }
  return { messages: transcript, queue: snapshot.queue || [] };
}
