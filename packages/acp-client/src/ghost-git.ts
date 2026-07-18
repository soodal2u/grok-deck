import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, normalize } from "node:path";
import { homedir } from "node:os";
import { constants as fsConstants } from "node:fs";

export type GhostChange = {
  /** Absolute path */
  path: string;
  /** Content before this commit (null = file was newly created) */
  previous: string | null;
  /** Content after this commit */
  next: string;
  /** Line-level stats for this turn only (vs previous snapshot) */
  add?: number;
  del?: number;
};

export type GhostCommit = {
  id: string;
  createdAt: number;
  message: string;
  changes: GhostChange[];
};

export type GhostStatus = {
  canUndo: boolean;
  depth: number;
  last?: { id: string; createdAt: number; message: string; fileCount: number };
};

/**
 * Normalize workspace path so the same project always maps to the same ghost store.
 * (Trailing slash / casing / relative segments used to create a "fresh empty" ghost.)
 */
export function ghostWorkspaceKey(workspaceRoot: string): string {
  let p = resolve(workspaceRoot);
  // Strip trailing separators
  p = p.replace(/[\\/]+$/, "") || p;
  // Windows: consistent casing for drive letter
  if (process.platform === "win32" && /^[a-zA-Z]:/.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  }
  return normalize(p).toLowerCase();
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function ghostStoreDir(workspaceRoot: string): string {
  const key = ghostWorkspaceKey(workspaceRoot);
  const hash = hashKey(key);
  const primary = join(homedir(), ".grokdeck", "ghost", hash);

  // Prefer existing store for this project, including pre-normalization path variants
  // so Ghost Git is never "reset" just because path casing/slash changed.
  const keyVariants = Array.from(
    new Set([
      key,
      workspaceRoot.toLowerCase(),
      resolve(workspaceRoot).toLowerCase(),
      resolve(workspaceRoot).replace(/[\\/]+$/, "").toLowerCase(),
      normalize(workspaceRoot).toLowerCase(),
    ]),
  );

  for (const k of keyVariants) {
    const h = hashKey(k);
    for (const root of [join(homedir(), ".grokdeck", "ghost"), join(homedir(), ".grok-deck", "ghost")]) {
      const dir = join(root, h);
      if (existsSync(join(dir, "history.json"))) return dir;
    }
  }

  const legacyPrimary = join(homedir(), ".grok-deck", "ghost", hash);
  if (!existsSync(primary) && existsSync(legacyPrimary)) return legacyPrimary;
  return primary;
}

/** LCS length for line arrays (O(n*m) with n,m capped for safety). */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  // Cap to keep commit fast on huge files
  if (n * m > 2_000_000) {
    // Approximate: unique multiset intersection
    const counts = new Map<string, number>();
    for (const line of a) counts.set(line, (counts.get(line) || 0) + 1);
    let common = 0;
    for (const line of b) {
      const c = counts.get(line) || 0;
      if (c > 0) {
        common++;
        counts.set(line, c - 1);
      }
    }
    return common;
  }
  const prev = new Array(m + 1).fill(0);
  const cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

/** Per-turn line add/del vs the previous snapshot (not cumulative project history). */
export function lineAddDel(previous: string | null, next: string): { add: number; del: number } {
  if (previous == null) {
    if (!next) return { add: 0, del: 0 };
    return { add: next.split(/\r?\n/).length, del: 0 };
  }
  if (previous === next) return { add: 0, del: 0 };
  const oldLines = previous.split(/\r?\n/);
  const newLines = next.split(/\r?\n/);
  const lcs = lcsLength(oldLines, newLines);
  return {
    add: Math.max(0, newLines.length - lcs),
    del: Math.max(0, oldLines.length - lcs),
  };
}

/**
 * Lightweight "ghost git": snapshot every agent write, undo by restoring snapshots.
 * Persists under ~/.grokdeck/ghost/<project-hash>/history.json across agent restarts.
 */
export class GhostGit {
  private readonly storeDir: string;
  private readonly logPath: string;
  /** Pending changes for the current turn (path → change) */
  private pending = new Map<string, GhostChange>();
  private history: GhostCommit[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private readonly maxCommits = 80;

  constructor(private readonly workspaceRoot: string) {
    this.storeDir = ghostStoreDir(workspaceRoot);
    this.logPath = join(this.storeDir, "history.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        await mkdir(this.storeDir, { recursive: true });
        const raw = await readFile(this.logPath, "utf8");
        const parsed = JSON.parse(raw) as GhostCommit[];
        if (Array.isArray(parsed)) this.history = parsed;
      } catch {
        // Missing or corrupt — start empty but do not wipe existing file until first persist
        if (!existsSync(this.logPath)) this.history = [];
      } finally {
        this.loaded = true;
      }
    })();
    return this.loadPromise;
  }

  /**
   * Record a write for the current turn.
   * First touch keeps original `previous`; later rewrites only update `next`.
   */
  recordWrite(path: string, previous: string | null, next: string): void {
    const existing = this.pending.get(path);
    if (existing) {
      existing.next = next;
      const stats = lineAddDel(existing.previous, next);
      existing.add = stats.add;
      existing.del = stats.del;
    } else {
      const stats = lineAddDel(previous, next);
      this.pending.set(path, {
        path,
        previous,
        next,
        add: stats.add,
        del: stats.del,
      });
    }
  }

  /** Flush pending writes into one commit (call on turn_done). */
  async commitTurn(message = "Agent turn"): Promise<GhostCommit | null> {
    await this.ensureLoaded();
    if (this.pending.size === 0) return null;

    const changes = [...this.pending.values()].map((ch) => {
      const stats = lineAddDel(ch.previous, ch.next);
      return { ...ch, add: stats.add, del: stats.del };
    });

    const commit: GhostCommit = {
      id: `g${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      message,
      changes,
    };
    this.pending.clear();
    this.history.push(commit);
    if (this.history.length > this.maxCommits) {
      this.history = this.history.slice(-this.maxCommits);
    }
    await this.persist();
    return commit;
  }

  /** Undo the last ghost commit — restore workspace files. */
  async undo(): Promise<{ ok: boolean; message: string; commit?: GhostCommit }> {
    await this.ensureLoaded();
    this.pending.clear();

    const commit = this.history.pop();
    if (!commit) {
      return { ok: false, message: "되돌릴 고스트 커밋이 없습니다" };
    }

    const reversed = [...commit.changes].reverse();
    for (const ch of reversed) {
      try {
        if (ch.previous == null) {
          try {
            await unlink(ch.path);
          } catch {
            /* already gone */
          }
        } else {
          await mkdir(dirname(ch.path), { recursive: true });
          await writeFile(ch.path, ch.previous, "utf8");
        }
      } catch (err) {
        this.history.push(commit);
        await this.persist();
        return {
          ok: false,
          message: `복원 실패 (${ch.path}): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await this.persist();
    return {
      ok: true,
      message: `실행 취소: ${commit.changes.length}개 파일 복원`,
      commit,
    };
  }

  /** Always loads from disk first so restarts show real depth. */
  async status(): Promise<GhostStatus> {
    await this.ensureLoaded();
    return this.statusSync();
  }

  statusSync(): GhostStatus {
    const last = this.history[this.history.length - 1];
    return {
      canUndo: this.history.length > 0 || this.pending.size > 0,
      depth: this.history.length,
      last: last
        ? {
            id: last.id,
            createdAt: last.createdAt,
            message: last.message,
            fileCount: last.changes.length,
          }
        : undefined,
    };
  }

  /** If there are uncommitted pending writes (turn still open), allow undoing them as a soft commit */
  async undoIncludingPending(): Promise<{ ok: boolean; message: string; commit?: GhostCommit }> {
    if (this.pending.size > 0) {
      await this.commitTurn("Partial turn (undo)");
    }
    return this.undo();
  }

  private async persist(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(this.logPath, JSON.stringify(this.history, null, 2), "utf8");
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
