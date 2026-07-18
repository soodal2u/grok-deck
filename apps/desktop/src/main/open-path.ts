import { readdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { shell } from "electron";

/**
 * Open a local file or folder from chat links.
 * - Folder → open in Explorer
 * - File → reveal in Explorer (folder opens with file selected)
 * - http(s) → default browser
 */
export async function openLocalPath(
  raw: string,
  projectRoot?: string | null,
): Promise<{ ok: boolean; message?: string; resolved?: string }> {
  let trimmed = (raw || "").trim();
  // Strip accidental markdown leftovers: [text](path) or bare brackets
  const md = trimmed.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (md) trimmed = (md[2] || md[1] || "").trim();
  trimmed = trimmed.replace(/^<|>$/g, "").replace(/^`+|`+$/g, "");

  if (!trimmed) return { ok: false, message: "빈 경로" };

  if (/^https?:\/\//i.test(trimmed)) {
    await shell.openExternal(trimmed);
    return { ok: true, resolved: trimmed };
  }

  let candidate = trimmed;
  if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = decodeURIComponent(candidate.replace(/^file:\/\/\/?/i, ""));
      if (process.platform === "win32" && !/^[A-Za-z]:/.test(candidate)) {
        candidate = candidate.replace(/^\//, "");
      }
    } catch {
      /* keep */
    }
  }

  // Normalize escapes from tool JSON / markdown
  candidate = candidate
    .replace(/\\\\/g, "\\")
    .replace(/%5[cC]/g, "\\")
    .replace(/%2[fF]/g, "/");

  try {
    if (/%[0-9A-Fa-f]{2}/.test(candidate)) {
      candidate = decodeURIComponent(candidate);
    }
  } catch {
    /* keep */
  }

  // Unify separators for matching, keep Windows drive form
  const resolved = resolvePathCandidate(candidate, projectRoot);
  if (!resolved || !existsSync(resolved)) {
    return {
      ok: false,
      message: `경로를 찾을 수 없습니다: ${candidate}`,
      resolved: resolved || candidate,
    };
  }

  try {
    const st = statSync(resolved);
    if (st.isDirectory()) {
      const err = await shell.openPath(resolved);
      if (err) return { ok: false, message: err, resolved };
    } else {
      // Electron API: open parent folder with file selected
      shell.showItemInFolder(resolved);
    }
    return { ok: true, resolved };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      resolved,
    };
  }
}

function resolvePathCandidate(candidate: string, projectRoot?: string | null): string | null {
  const tries: string[] = [];
  const norm = candidate.replace(/\//g, sep);

  if (isAbsolute(norm) || /^[A-Za-z]:[\\/]/.test(norm)) {
    tries.push(normalize(norm));
  }

  if (projectRoot) {
    tries.push(resolve(projectRoot, candidate));
    tries.push(resolve(projectRoot, candidate.replace(/^\.\//, "")));
    tries.push(resolve(projectRoot, norm));
  }

  const grokHome = join(homedir(), ".grok");
  tries.push(resolve(grokHome, candidate));
  tries.push(resolve(grokHome, "sessions", candidate));

  // Relative paths like images/1.jpg — search all sessions, pick newest match
  const relativeLike =
    /^(?:\.\/)?(?:images?|attachments?)[/\\]/i.test(candidate) ||
    (!isAbsolute(candidate) && !/^[A-Za-z]:/.test(candidate) && candidate.includes("/"));

  if (relativeLike) {
    const matches = findAllUnderSessions(candidate);
    if (matches.length > 0) {
      matches.sort((a, b) => b.mtime - a.mtime);
      return matches[0]!.path;
    }
  }

  // Also try bare filename in session images folders
  const base = basename(candidate.replace(/\\/g, "/"));
  if (/\.(png|jpe?g|webp|gif|mp4|webm)$/i.test(base)) {
    const matches = findAllUnderSessions(join("images", base));
    matches.push(...findAllUnderSessions(base));
    if (matches.length > 0) {
      matches.sort((a, b) => b.mtime - a.mtime);
      return matches[0]!.path;
    }
  }

  for (const t of tries) {
    try {
      if (existsSync(t)) return t;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function findAllUnderSessions(relativePath: string): Array<{ path: string; mtime: number }> {
  const out: Array<{ path: string; mtime: number }> = [];
  const sessionsRoot = join(homedir(), ".grok", "sessions");
  if (!existsSync(sessionsRoot)) return out;

  const rel = relativePath.replace(/^[./\\]+/, "").replace(/\//g, sep);

  let projects: string[] = [];
  try {
    projects = readdirSync(sessionsRoot);
  } catch {
    return out;
  }

  for (const proj of projects) {
    const projPath = join(sessionsRoot, proj);
    let sids: string[] = [];
    try {
      sids = readdirSync(projPath);
    } catch {
      continue;
    }
    for (const sid of sids) {
      const candidates = [
        join(projPath, sid, rel),
        join(projPath, sid, "assets", basename(rel)),
        join(projPath, sid, "images", basename(rel)),
      ];
      for (const full of candidates) {
        try {
          if (existsSync(full)) {
            const st = statSync(full);
            out.push({ path: full, mtime: st.mtimeMs });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}
