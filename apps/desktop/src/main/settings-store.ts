import { readFile, writeFile, mkdir } from "node:fs/promises";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ProjectState,
  type WindowBounds,
} from "@grok-deck/shared";
import { deckHome, ensureDeckHome } from "./paths";

const DIR = () => deckHome();
const SETTINGS_PATH = () => join(DIR(), "settings.json");
const PROJECT_PATH = () => join(DIR(), "project.json");

async function ensureDir() {
  ensureDeckHome();
  if (!existsSync(DIR())) {
    await mkdir(DIR(), { recursive: true });
  }
}

function ensureDirSync() {
  ensureDeckHome();
  if (!existsSync(DIR())) {
    mkdirSync(DIR(), { recursive: true });
  }
}

function normalizeBounds(b: unknown): WindowBounds | undefined {
  if (!b || typeof b !== "object") return undefined;
  const o = b as Record<string, unknown>;
  const width = typeof o.width === "number" && o.width > 0 ? Math.round(o.width) : undefined;
  const height = typeof o.height === "number" && o.height > 0 ? Math.round(o.height) : undefined;
  if (width == null || height == null) return undefined;
  return {
    width,
    height,
    x: typeof o.x === "number" ? Math.round(o.x) : undefined,
    y: typeof o.y === "number" ? Math.round(o.y) : undefined,
    isMaximized: Boolean(o.isMaximized),
  };
}

function migrateSettings(parsed: Partial<AppSettings> & {
  alwaysApprove?: boolean;
  permissionMode?: string;
}): AppSettings {
  const migrated: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...parsed,
    model: parsed.model ?? DEFAULT_SETTINGS.model,
    grokPath: parsed.grokPath ?? DEFAULT_SETTINGS.grokPath,
    deckMode: parsed.deckMode ?? DEFAULT_SETTINGS.deckMode,
    reasoningEffort: parsed.reasoningEffort ?? DEFAULT_SETTINGS.reasoningEffort,
    theme: parsed.theme ?? DEFAULT_SETTINGS.theme,
    wallpaperOpacity:
      typeof parsed.wallpaperOpacity === "number"
        ? parsed.wallpaperOpacity
        : DEFAULT_SETTINGS.wallpaperOpacity,
    windowBounds: normalizeBounds(parsed.windowBounds),
    sidebarWidth:
      typeof parsed.sidebarWidth === "number"
        ? parsed.sidebarWidth
        : DEFAULT_SETTINGS.sidebarWidth,
    rightWidth:
      typeof parsed.rightWidth === "number"
        ? parsed.rightWidth
        : DEFAULT_SETTINGS.rightWidth,
    customThemeId: parsed.customThemeId,
    projectOrder: Array.isArray(parsed.projectOrder)
      ? parsed.projectOrder.filter((p): p is string => typeof p === "string")
      : DEFAULT_SETTINGS.projectOrder,
    sidebarExpanded:
      parsed.sidebarExpanded && typeof parsed.sidebarExpanded === "object"
        ? parsed.sidebarExpanded
        : DEFAULT_SETTINGS.sidebarExpanded,
    notifyMessage:
      typeof parsed.notifyMessage === "boolean"
        ? parsed.notifyMessage
        : DEFAULT_SETTINGS.notifyMessage,
    notifySound:
      typeof parsed.notifySound === "boolean" ? parsed.notifySound : DEFAULT_SETTINGS.notifySound,
  };
  if (!parsed.deckMode && parsed.alwaysApprove) migrated.deckMode = "yolo";
  if (!parsed.deckMode && parsed.permissionMode === "plan") migrated.deckMode = "plan";
  if (!parsed.deckMode && parsed.permissionMode === "bypassPermissions") {
    migrated.deckMode = "yolo";
  }
  return migrated;
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    await ensureDir();
    if (!existsSync(SETTINGS_PATH())) return { ...DEFAULT_SETTINGS };
    const raw = await readFile(SETTINGS_PATH(), "utf8");
    return migrateSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Sync load for quit path (must finish before process exits). */
export function loadSettingsSync(): AppSettings {
  try {
    ensureDirSync();
    if (!existsSync(SETTINGS_PATH())) return { ...DEFAULT_SETTINGS };
    const raw = readFileSync(SETTINGS_PATH(), "utf8");
    return migrateSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await ensureDir();
  await writeFile(SETTINGS_PATH(), JSON.stringify(settings, null, 2), "utf8");
}

/** Sync save for close/quit — avoids losing window size when async write is cut off. */
export function saveSettingsSync(settings: AppSettings): void {
  ensureDirSync();
  writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2), "utf8");
}

/**
 * Merge UI settings without letting stale renderer state wipe windowBounds.
 * Only an explicit `windowBounds` patch (from main persistBounds) should update size.
 */
export function mergeSettings(
  prev: AppSettings,
  patch: Partial<AppSettings>,
  opts?: { updateWindowBounds?: boolean },
): AppSettings {
  const next: AppSettings = {
    ...prev,
    ...patch,
    // Always keep previous bounds unless main process is intentionally saving size
    windowBounds: opts?.updateWindowBounds
      ? normalizeBounds(patch.windowBounds) ?? prev.windowBounds
      : prev.windowBounds,
  };
  return next;
}

/** Persist only window bounds (resize/move/close). */
export function saveWindowBoundsSync(bounds: WindowBounds): void {
  const cur = loadSettingsSync();
  saveSettingsSync({
    ...cur,
    windowBounds: normalizeBounds(bounds) ?? bounds,
  });
}

export async function loadProjectState(): Promise<ProjectState> {
  try {
    await ensureDir();
    if (!existsSync(PROJECT_PATH())) return { root: null, recent: [] };
    const raw = await readFile(PROJECT_PATH(), "utf8");
    return JSON.parse(raw) as ProjectState;
  } catch {
    return { root: null, recent: [] };
  }
}

export async function saveProjectState(state: ProjectState): Promise<void> {
  await ensureDir();
  await writeFile(PROJECT_PATH(), JSON.stringify(state, null, 2), "utf8");
}
