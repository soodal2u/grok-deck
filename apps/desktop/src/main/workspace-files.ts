import { readdir, stat } from "node:fs/promises";
import { join, relative, basename, sep } from "node:path";
import type { WorkspaceFileEntry } from "@grok-deck/shared";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".grok",
  "dist",
  "build",
  "out",
  "release",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
]);

/**
 * Lightweight workspace file search for @ mentions.
 */
export async function searchWorkspaceFiles(
  root: string,
  query = "",
  limit = 40,
): Promise<WorkspaceFileEntry[]> {
  if (!root) return [];
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const results: WorkspaceFileEntry[] = [];

  async function walk(dir: string, depth: number) {
    if (results.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Prefer shallow matches: score later
    for (const ent of entries) {
      if (results.length >= limit) return;
      const name = ent.name;
      if (name.startsWith(".") && name !== ".env" && name !== ".env.local") continue;
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (q && !rel.toLowerCase().includes(q) && !name.toLowerCase().includes(q)) continue;
        results.push({ path: full, relative: rel, name });
      }
    }
  }

  await walk(root, 0);

  // Rank: basename startsWith, then path includes
  if (q) {
    results.sort((a, b) => {
      const as = score(a, q);
      const bs = score(b, q);
      return bs - as || a.relative.localeCompare(b.relative);
    });
  } else {
    results.sort((a, b) => a.relative.localeCompare(b.relative));
  }

  return results.slice(0, limit);
}

function score(e: WorkspaceFileEntry, q: string): number {
  const name = e.name.toLowerCase();
  const rel = e.relative.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (rel.includes(q)) return 40;
  return 0;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export { basename };
