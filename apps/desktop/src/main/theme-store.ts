import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { deckHome, ensureDeckHome } from "./paths";

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

export type CustomTheme = {
  id: string;
  label: string;
  /** Filename under themesDir */
  file: string;
  prompt?: string;
  createdAt: string;
  source?: string;
};

export type ThemeCatalog = {
  themes: CustomTheme[];
};

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function themesDir(): string {
  return join(deckHome(), "themes");
}

function catalogPath(): string {
  return join(themesDir(), "catalog.json");
}

async function ensure(): Promise<void> {
  ensureDeckHome();
  await mkdir(themesDir(), { recursive: true });
  if (!existsSync(catalogPath())) {
    await writeFile(catalogPath(), JSON.stringify({ themes: [] }, null, 2), "utf8");
  }
}

export async function loadCatalog(): Promise<ThemeCatalog> {
  await ensure();
  try {
    const raw = JSON.parse(await readFile(catalogPath(), "utf8")) as ThemeCatalog;
    if (!Array.isArray(raw.themes)) return { themes: [] };
    // Drop entries whose file is missing
    const themes = raw.themes.filter((t) => existsSync(join(themesDir(), t.file)));
    return { themes };
  } catch {
    return { themes: [] };
  }
}

async function saveCatalog(catalog: ThemeCatalog): Promise<void> {
  await ensure();
  await writeFile(catalogPath(), JSON.stringify(catalog, null, 2), "utf8");
}

export function themeFilePath(file: string): string {
  return join(themesDir(), file);
}

export async function importImageFile(
  sourcePath: string,
  options?: { label?: string; prompt?: string; source?: string },
): Promise<{ ok: boolean; theme?: CustomTheme; message: string }> {
  await ensure();
  if (!existsSync(sourcePath)) {
    return { ok: false, message: `파일을 찾을 수 없습니다: ${sourcePath}` };
  }
  const ext = extname(sourcePath).toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    return { ok: false, message: `이미지 형식이 아닙니다: ${ext || "(없음)"}` };
  }

  const id = `c_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const file = `${id}${ext === ".jpeg" ? ".jpg" : ext}`;
  const dest = join(themesDir(), file);
  await copyFile(sourcePath, dest);

  const label =
    options?.label?.trim() ||
    basename(sourcePath, extname(sourcePath)).slice(0, 48) ||
    `테마 ${id.slice(2, 8)}`;

  const theme: CustomTheme = {
    id,
    label,
    file,
    prompt: options?.prompt,
    createdAt: new Date().toISOString(),
    source: options?.source || sourcePath,
  };

  const catalog = await loadCatalog();
  catalog.themes.unshift(theme);
  // Keep last 40 custom themes
  catalog.themes = catalog.themes.slice(0, 40);
  await saveCatalog(catalog);

  return { ok: true, theme, message: `테마로 가져옴: ${label}` };
}

export async function deleteCustomTheme(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const catalog = await loadCatalog();
  const idx = catalog.themes.findIndex((t) => t.id === id);
  if (idx < 0) return { ok: false, message: "테마를 찾을 수 없습니다" };
  const [removed] = catalog.themes.splice(idx, 1);
  if (removed) {
    try {
      await unlink(join(themesDir(), removed.file));
    } catch {
      /* ignore */
    }
  }
  await saveCatalog(catalog);
  return { ok: true, message: "테마 삭제됨" };
}

type FoundImage = { path: string; mtimeMs: number; size: number };

async function collectImages(dir: string, maxDepth: number, out: FoundImage[]): Promise<void> {
  if (maxDepth < 0 || !existsSync(dir)) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip huge / irrelevant trees
      if (["node_modules", ".git", "bin", "vendor"].includes(ent.name)) continue;
      await collectImages(full, maxDepth - 1, out);
    } else if (ent.isFile()) {
      const ext = extname(ent.name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) continue;
      try {
        const st = await stat(full);
        // Skip tiny icons / huge videos disguised
        if (st.size < 8_000 || st.size > 25_000_000) continue;
        out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Find newest images from Grok session folders and user Downloads.
 */
export async function findRecentGeneratedImages(options?: {
  sinceMs?: number;
  limit?: number;
}): Promise<FoundImage[]> {
  const since = options?.sinceMs ?? Date.now() - 1000 * 60 * 60 * 24 * 14;
  const limit = options?.limit ?? 30;
  const found: FoundImage[] = [];

  const roots = [
    join(homedir(), ".grok", "sessions"),
    join(homedir(), ".grok", "downloads"),
    join(homedir(), ".grok", "attachments"),
    join(homedir(), "Downloads"),
    join(homedir(), "Pictures"),
  ];

  for (const root of roots) {
    await collectImages(root, root.includes("sessions") ? 5 : 2, found);
  }

  return found
    .filter((f) => f.mtimeMs >= since)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);
}

export async function importLatestGenerated(options?: {
  sinceMs?: number;
  label?: string;
  prompt?: string;
}): Promise<{ ok: boolean; theme?: CustomTheme; message: string; path?: string }> {
  const recent = await findRecentGeneratedImages({
    sinceMs: options?.sinceMs ?? Date.now() - 1000 * 60 * 30,
    limit: 5,
  });
  if (recent.length === 0) {
    return {
      ok: false,
      message:
        "최근 생성된 이미지를 찾지 못했습니다. /imagine 실행 후 다시 시도하거나 파일을 직접 가져오세요.",
    };
  }
  const newest = recent[0]!;
  const result = await importImageFile(newest.path, {
    label: options?.label,
    prompt: options?.prompt,
    source: newest.path,
  });
  return { ...result, path: newest.path };
}

/**
 * Wait until a new image appears after `sinceMs` (for post-/imagine import).
 */
export async function waitForNewImage(options: {
  sinceMs: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<FoundImage | null> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  const seen = new Set(
    (await findRecentGeneratedImages({ sinceMs: 0, limit: 50 })).map((f) => f.path),
  );

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const recent = await findRecentGeneratedImages({
      sinceMs: options.sinceMs - 1000,
      limit: 10,
    });
    const fresh = recent.find((f) => f.mtimeMs >= options.sinceMs && !seen.has(f.path));
    if (fresh) return fresh;
    // Also accept files that appeared in seen with newer mtime after start
    for (const f of recent) {
      if (f.mtimeMs >= options.sinceMs && f.size > 20_000) {
        if (!seen.has(f.path) || f.mtimeMs >= options.sinceMs) {
          return f;
        }
      }
    }
  }
  return null;
}

export function catalogFingerprint(catalog: ThemeCatalog): string {
  return createHash("sha1")
    .update(JSON.stringify(catalog.themes.map((t) => t.id)))
    .digest("hex")
    .slice(0, 12);
}

/** Reliable wallpaper source for the renderer (avoids custom-protocol CSP issues). */
export async function getThemeDataUrl(themeId: string): Promise<string | null> {
  const catalog = await loadCatalog();
  const t = catalog.themes.find((x) => x.id === themeId);
  if (!t) return null;
  const file = join(themesDir(), t.file);
  if (!existsSync(file)) return null;
  const buf = await readFile(file);
  const mime = mimeForExt(extname(t.file));
  return `data:${mime};base64,${buf.toString("base64")}`;
}
