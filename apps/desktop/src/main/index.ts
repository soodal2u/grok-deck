import { app, BrowserWindow, dialog, ipcMain, net, Notification, protocol, screen, shell } from "electron";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  IpcChannels,
  type AppSettings,
  type DeckMode,
  type OpenExternalTarget,
  type ClipboardImagePayload,
  type PromptRequest,
  type ReasoningEffort,
  type ThreadSnapshot,
  type ChatMessage,
} from "@grok-deck/shared";
import { getAuthStatus, loginWithGrokCli, logoutLocal } from "./auth";
import {
  loadProjectState,
  loadSettings,
  mergeSettings,
  saveProjectState,
  saveSettings,
  saveWindowBoundsSync,
} from "./settings-store";
import {
  createProject,
  deleteSession,
  listProjects,
  loadTranscript,
} from "./session-store";
import {
  deleteThreadSnapshot,
  loadThreadSnapshot,
  mergeTranscriptWithSnapshot,
  saveThreadSnapshot,
} from "./thread-store";
import { openProjectExternal } from "./open-external";
import { openLocalPath } from "./open-path";
import { applyEdgeResize, type ResizeEdge } from "./window-resize";
import {
  deleteCustomTheme,
  findRecentGeneratedImages,
  getThemeDataUrl,
  importImageFile,
  importLatestGenerated,
  loadCatalog,
  themeFilePath,
  themesDir,
  waitForNewImage,
} from "./theme-store";
import { AgentManager } from "./agent-manager";
import { ensureDeckHome } from "./paths";
import {
  attachmentFromClipboardImage,
  attachmentsFromPaths,
  buildPromptContent,
  pickAttachments,
} from "./attachments";
import { listSkills, skillsAsSlashCommands } from "./skills-list";
import { searchWorkspaceFiles } from "./workspace-files";

// Custom protocol for loading wallpapers from ~/.grokdeck/themes
protocol.registerSchemesAsPrivileged([
  {
    scheme: "deck-theme",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

if (process.platform === "win32") {
  app.setAppUserModelId("app.grokdeck.desktop");
}

let mainWindow: BrowserWindow | null = null;
const agent = new AgentManager(() => mainWindow);

/** Active custom edge-resize drag (wider hit targets than native Windows border). */
let resizeDrag: {
  edge: ResizeEdge;
  startX: number;
  startY: number;
  bounds: { x: number; y: number; width: number; height: number };
} | null = null;

function resolveIcon(): string | undefined {
  const candidates = [
    join(__dirname, "../../resources/icon.png"),
    join(__dirname, "../resources/icon.png"),
    join(app.getAppPath(), "resources/icon.png"),
    join(process.cwd(), "apps/desktop/resources/icon.png"),
  ];
  return candidates.find((p) => existsSync(p));
}

async function createWindow() {
  const settings = await loadSettings();
  const bounds = settings.windowBounds;
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay().workArea;

  let width = bounds?.width ?? 1280;
  let height = bounds?.height ?? 840;
  let x = bounds?.x;
  let y = bounds?.y;

  // Prefer the display that contains the saved position (multi-monitor safe)
  let hostArea = primary;
  if (x != null && y != null) {
    const host = screen.getDisplayNearestPoint({ x, y });
    hostArea = host.workArea;
    const onScreen = displays.some((d) => {
      const a = d.workArea;
      return x! < a.x + a.width && x! + width > a.x && y! < a.y + a.height && y! + height > a.y;
    });
    if (!onScreen) {
      x = undefined;
      y = undefined;
      hostArea = primary;
    }
  }

  // Clamp to the host display, but keep user's size as much as possible
  width = Math.max(960, Math.min(width, hostArea.width));
  height = Math.max(640, Math.min(height, hostArea.height));
  if (x != null) {
    x = Math.min(Math.max(x, hostArea.x), hostArea.x + hostArea.width - width);
  }
  if (y != null) {
    y = Math.min(Math.max(y, hostArea.y), hostArea.y + hostArea.height - height);
  }

  const icon = resolveIcon();

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 960,
    minHeight: 640,
    title: `Grok Deck ${app.getVersion()}`,
    backgroundColor: "#0b0d10",
    show: false,
    icon,
    // Windows: thicker non-client frame makes native edge resize easier to grab
    thickFrame: true,
    resizable: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (bounds?.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  /** Flush current window geometry to disk (sync on close so size is never lost). */
  const captureBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const isMaximized = mainWindow.isMaximized();
    const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized,
    };
  };

  const persistBoundsSync = () => {
    const b = captureBounds();
    if (!b) return;
    try {
      saveWindowBoundsSync(b);
    } catch {
      /* ignore disk errors on quit */
    }
  };

  const persistBoundsAsync = async () => {
    const b = captureBounds();
    if (!b) return;
    try {
      const cur = await loadSettings();
      await saveSettings(
        mergeSettings(cur, { windowBounds: b }, { updateWindowBounds: true }),
      );
    } catch {
      persistBoundsSync();
    }
  };

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistBoundsAsync(), 250);
  };

  mainWindow.on("resize", scheduleSave);
  mainWindow.on("move", scheduleSave);
  mainWindow.on("maximize", scheduleSave);
  mainWindow.on("unmaximize", scheduleSave);
  // Sync flush — async void on close was racing process exit and losing size
  mainWindow.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistBoundsSync();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function showTurnNotification(payload: {
  title?: string;
  body?: string;
  silent?: boolean;
  force?: boolean;
}): { ok: boolean; skipped?: string } {
  if (!Notification.isSupported()) return { ok: false, skipped: "unsupported" };
  const focused = Boolean(mainWindow?.isFocused() && !mainWindow.isMinimized());
  if (focused && !payload.force) return { ok: true, skipped: "focused" };
  const n = new Notification({
    title: payload.title?.trim() || "Grok Deck",
    body: payload.body?.trim() || "작업이 끝났습니다",
    icon: resolveIcon(),
    silent: Boolean(payload.silent),
  });
  n.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  n.show();
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle(IpcChannels.appGetVersion, () => app.getVersion());

  ipcMain.handle(
    IpcChannels.appNotify,
    (
      _e,
      payload?: { title?: string; body?: string; silent?: boolean; force?: boolean },
    ) => showTurnNotification(payload || {}),
  );

  ipcMain.handle(IpcChannels.authGetStatus, async () => getAuthStatus());

  ipcMain.handle(IpcChannels.authLogin, async () => {
    const settings = await loadSettings();
    const result = await loginWithGrokCli(settings.grokPath || "grok");
    const status = await getAuthStatus();
    return { ...result, status };
  });

  ipcMain.handle(IpcChannels.authLogout, async () => {
    await logoutLocal();
    return getAuthStatus();
  });

  ipcMain.handle(IpcChannels.settingsGet, async () => loadSettings());

  ipcMain.handle(IpcChannels.settingsSet, async (_e, settings: AppSettings) => {
    const prev = await loadSettings();
    // Renderer state often has stale windowBounds (captured at load time).
    // Never let UI settings overwrites wipe the size saved by resize/move/close.
    const next = mergeSettings(prev, settings, { updateWindowBounds: false });
    await saveSettings(next);

    // Restart agent if model/effort changed and a project is open
    const effortChanged = prev.reasoningEffort !== next.reasoningEffort;
    const modelChanged = prev.model !== next.model;
    if ((effortChanged || modelChanged) && agent.getStatus().state !== "idle") {
      await agent.applySettingsAndRestart(next);
    }
    return next;
  });

  ipcMain.handle(IpcChannels.projectGet, async () => loadProjectState());

  ipcMain.handle(
    IpcChannels.projectOpenExternal,
    async (_e, target: OpenExternalTarget, cwd?: string) => {
      const project = await loadProjectState();
      const root = cwd || project.root;
      if (!root) return { ok: false, message: "No project selected" };
      return openProjectExternal(root, target);
    },
  );

  ipcMain.handle(
    IpcChannels.shellOpenPath,
    async (_e, pathOrUrl: string, projectRoot?: string) => {
      const project = await loadProjectState();
      return openLocalPath(pathOrUrl, projectRoot || project.root);
    },
  );

  ipcMain.handle(IpcChannels.projectOpen, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openDirectory", "createDirectory"],
      title: "Open project folder",
    });
    if (result.canceled || !result.filePaths[0]) {
      return loadProjectState();
    }

    const root = result.filePaths[0];
    const prev = await loadProjectState();
    const recent = [root, ...prev.recent.filter((p) => p !== root)].slice(0, 12);
    const state = { root, recent };
    await saveProjectState(state);

    const settings = await loadSettings();
    await agent.start(root, settings);
    return state;
  });

  ipcMain.handle(IpcChannels.agentStart, async (_e, cwd?: string) => {
    const project = await loadProjectState();
    const root = cwd || project.root;
    if (!root) {
      return { state: "error", message: "No project selected" };
    }
    const settings = await loadSettings();
    if (cwd && cwd !== project.root) {
      const recent = [cwd, ...project.recent.filter((p) => p !== cwd)].slice(0, 12);
      await saveProjectState({ root: cwd, recent });
    }
    return agent.start(root, settings);
  });

  ipcMain.handle(IpcChannels.agentStop, async () => {
    await agent.stop();
    return agent.getStatus();
  });

  ipcMain.handle(IpcChannels.agentPrompt, async (_e, req: string | PromptRequest) => {
    const text = typeof req === "string" ? req : req?.text || "";
    const attachments = typeof req === "string" ? [] : req?.attachments || [];
    const content = await buildPromptContent(text, attachments);
    await agent.prompt(text, content);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.attachmentsPick, async () => pickAttachments(mainWindow));

  ipcMain.handle(IpcChannels.attachmentsFromPaths, async (_e, paths: string[]) =>
    attachmentsFromPaths(Array.isArray(paths) ? paths : []),
  );

  ipcMain.handle(
    IpcChannels.attachmentsFromData,
    async (_e, payload: ClipboardImagePayload) => {
      if (!payload?.data) return null;
      try {
        return await attachmentFromClipboardImage(payload);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(IpcChannels.skillsList, async (_e, cwd?: string) => {
    const project = await loadProjectState();
    const root = cwd || project.root;
    return listSkills(root);
  });

  ipcMain.handle(
    IpcChannels.workspaceSearchFiles,
    async (_e, query?: string, cwd?: string) => {
      const project = await loadProjectState();
      const root = cwd || project.root;
      if (!root) return [];
      return searchWorkspaceFiles(root, query || "", 40);
    },
  );

  ipcMain.handle(IpcChannels.agentCancel, async () => {
    await agent.cancel();
    return { ok: true };
  });

  ipcMain.handle(
    IpcChannels.agentRespondPermission,
    async (_e, requestId: number, optionId: string) => {
      await agent.respondPermission(requestId, optionId);
      return { ok: true };
    },
  );

  ipcMain.handle(IpcChannels.agentSetMode, async (_e, mode: DeckMode) => {
    const next = await agent.setMode(mode);
    const settings = await loadSettings();
    await saveSettings(mergeSettings(settings, { deckMode: next }));
    return next;
  });

  ipcMain.handle(IpcChannels.agentGetMode, async () => agent.getMode());

  ipcMain.handle(IpcChannels.agentStatus, async () => agent.getStatus());

  ipcMain.handle(IpcChannels.agentGetPlan, async () => agent.getLastPlan());

  ipcMain.handle(IpcChannels.agentGetCommands, async () => {
    const remote = agent.getCommands();
    const project = await loadProjectState();
    const skills = skillsAsSlashCommands(await listSkills(project.root));
    // Merge: agent commands first, then skills not already present
    const map = new Map(remote.map((c) => [c.name.toLowerCase(), c]));
    for (const s of skills) {
      if (!map.has(s.name.toLowerCase())) map.set(s.name.toLowerCase(), s);
    }
    return [...map.values()];
  });

  ipcMain.handle(IpcChannels.agentSetEffort, async (_e, effort: ReasoningEffort) => {
    const settings = await loadSettings();
    const next = mergeSettings(settings, { reasoningEffort: effort });
    await saveSettings(next);
    if (agent.getStatus().state !== "idle") {
      await agent.applySettingsAndRestart(next);
    }
    return effort;
  });

  ipcMain.handle(IpcChannels.ghostUndo, async () => agent.undoGhost());
  ipcMain.handle(IpcChannels.ghostStatus, async () => agent.ghostStatus());

  ipcMain.handle(IpcChannels.sessionsList, async (_e, includeNoise?: boolean) =>
    listProjects({ includeNoise: Boolean(includeNoise) }),
  );

  ipcMain.handle(
    IpcChannels.sessionsTranscript,
    async (_e, sessionId: string, cwd: string) => {
      const transcript = await loadTranscript(sessionId, cwd);
      const snap = await loadThreadSnapshot(sessionId, cwd);
      const merged = mergeTranscriptWithSnapshot(transcript as unknown as ChatMessage[], snap);
      return { messages: merged.messages, queue: merged.queue, snapshotAt: snap?.updatedAt || 0 };
    },
  );

  ipcMain.handle(
    IpcChannels.sessionsDelete,
    async (_e, sessionId: string, cwd: string) => {
      const res = await deleteSession(sessionId, cwd);
      await deleteThreadSnapshot(sessionId, cwd);
      return res;
    },
  );

  ipcMain.handle(IpcChannels.threadGet, async (_e, sessionId: string, cwd: string) =>
    loadThreadSnapshot(sessionId, cwd),
  );

  ipcMain.handle(IpcChannels.threadSet, async (_e, snap: ThreadSnapshot) => {
    await saveThreadSnapshot(snap);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.projectCreate, async (_e, name: string) => {
    const result = await createProject(name);
    if (!result.ok || !result.cwd) return result;
    const prev = await loadProjectState();
    const recent = [result.cwd, ...prev.recent.filter((p) => p !== result.cwd)].slice(0, 12);
    await saveProjectState({ root: result.cwd, recent });
    const settings = await loadSettings();
    await agent.start(result.cwd, settings);
    return { ...result, project: { root: result.cwd, recent } };
  });

  ipcMain.handle(
    IpcChannels.agentLoadSession,
    async (_e, cwd: string, sessionId: string) => {
      const settings = await loadSettings();
      const prev = await loadProjectState();
      const recent = [cwd, ...prev.recent.filter((p) => p !== cwd)].slice(0, 12);
      await saveProjectState({ root: cwd, recent });
      return agent.loadSession(cwd, sessionId, settings);
    },
  );

  // Wider-than-native window resize grips (renderer edge handles)
  ipcMain.on(
    "window:resize-start",
    (
      _e,
      payload: { edge: ResizeEdge; screenX: number; screenY: number },
    ) => {
      if (!mainWindow || mainWindow.isMaximized()) return;
      const b = mainWindow.getBounds();
      resizeDrag = {
        edge: payload.edge,
        startX: payload.screenX,
        startY: payload.screenY,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      };
    },
  );

  ipcMain.on(
    "window:resize-move",
    (_e, payload: { screenX: number; screenY: number }) => {
      if (!mainWindow || !resizeDrag) return;
      const dx = payload.screenX - resizeDrag.startX;
      const dy = payload.screenY - resizeDrag.startY;
      applyEdgeResize(mainWindow, resizeDrag.edge, resizeDrag.bounds, dx, dy);
    },
  );

  ipcMain.on("window:resize-end", () => {
    resizeDrag = null;
  });

  // ── Custom themes ──
  ipcMain.handle(IpcChannels.themesList, async () => loadCatalog());

  ipcMain.handle(IpcChannels.themesDataUrl, async (_e, themeId: string) => {
    return getThemeDataUrl(themeId);
  });

  ipcMain.handle(IpcChannels.themesRecent, async () => {
    const recent = await findRecentGeneratedImages({
      sinceMs: Date.now() - 1000 * 60 * 60 * 24 * 30,
      limit: 20,
    });
    return recent.map((r) => ({
      path: r.path,
      mtimeMs: r.mtimeMs,
      size: r.size,
    }));
  });

  ipcMain.handle(IpcChannels.themesImportFile, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      title: "테마 배경 이미지 가져오기",
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, message: "취소됨" };
    }
    return importImageFile(result.filePaths[0], { source: "file-picker" });
  });

  ipcMain.handle(
    IpcChannels.themesImportPath,
    async (_e, filePath: string, label?: string) => {
      return importImageFile(filePath, { label, source: filePath });
    },
  );

  ipcMain.handle(
    IpcChannels.themesImportLatest,
    async (_e, opts?: { sinceMs?: number; label?: string; prompt?: string }) => {
      return importLatestGenerated(opts);
    },
  );

  ipcMain.handle(IpcChannels.themesDelete, async (_e, id: string) => {
    const settings = await loadSettings();
    const res = await deleteCustomTheme(id);
    if (res.ok && settings.customThemeId === id) {
      await saveSettings(
        mergeSettings(settings, { theme: "ember", customThemeId: undefined }),
      );
    }
    return res;
  });

  /**
   * Run /imagine via the agent, wait for a new image file, import as custom theme, apply.
   */
  ipcMain.handle(
    IpcChannels.themesGenerate,
    async (_e, prompt: string) => {
      const text = (prompt || "").trim();
      if (!text) return { ok: false, message: "프롬프트를 입력하세요" };

      const project = await loadProjectState();
      const settings = await loadSettings();
      if (!project.root) {
        return { ok: false, message: "먼저 프로젝트를 열어 주세요 (에이전트 세션 필요)" };
      }

      const st = agent.getStatus();
      if (st.state === "idle" || st.state === "error") {
        await agent.start(project.root, settings);
      }

      const sinceMs = Date.now();
      const fullPrompt = `/imagine ${text}`;

      // Fire agent prompt (may take a while)
      const promptPromise = agent.prompt(fullPrompt).catch((err: unknown) => {
        throw err;
      });

      // Race: wait for image file while agent runs
      const imagePromise = waitForNewImage({
        sinceMs,
        timeoutMs: 180_000,
        pollMs: 2500,
      });

      try {
        const [, image] = await Promise.all([
          promptPromise.catch(() => undefined),
          imagePromise,
        ]);

        // Prefer waited image; fall back to latest scan
        let importResult;
        if (image) {
          importResult = await importImageFile(image.path, {
            label: text.slice(0, 40),
            prompt: text,
            source: image.path,
          });
        } else {
          importResult = await importLatestGenerated({
            sinceMs: sinceMs - 5000,
            label: text.slice(0, 40),
            prompt: text,
          });
        }

        if (!importResult.ok || !importResult.theme) {
          return {
            ok: false,
            message:
              importResult.message ||
              "이미지 생성은 됐을 수 있으나 파일을 찾지 못했습니다. 「최근 이미지 가져오기」를 눌러 보세요.",
          };
        }

        // Re-load so we don't overwrite windowBounds with a stale snapshot
        const latest = await loadSettings();
        const next = mergeSettings(latest, {
          theme: `custom:${importResult.theme.id}`,
          customThemeId: importResult.theme.id,
          wallpaperOpacity: Math.max(latest.wallpaperOpacity || 0.22, 0.22),
        });
        await saveSettings(next);

        return {
          ok: true,
          message: `테마 적용: ${importResult.theme.label}`,
          theme: importResult.theme,
          settings: next,
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

// Last-chance flush if window close handlers were skipped
app.on("before-quit", () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isMaximized = mainWindow.isMaximized();
      const b = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      saveWindowBoundsSync({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        isMaximized,
      });
    }
  } catch {
    /* ignore */
  }
});

app.whenReady().then(() => {
  // Serve custom theme files: deck-theme://<filename>
  protocol.handle("deck-theme", (request) => {
    try {
      // Accept deck-theme://file.jpg  OR  deck-theme:///file.jpg  OR host/path forms
      let name = "";
      try {
        const u = new URL(request.url);
        name = decodeURIComponent((u.hostname || "") + (u.pathname || ""));
        name = name.replace(/^\/+/, "").replace(/\/+$/, "");
      } catch {
        name = request.url
          .replace(/^deck-theme:\/\//, "")
          .replace(/^\//, "")
          .replace(/\/$/, "");
        try {
          name = decodeURIComponent(name);
        } catch {
          /* keep */
        }
      }
      // hostname may include dots from filename — already concatenated above
      if (!name) {
        return new Response("Empty", { status: 400 });
      }
      const file = themeFilePath(name);
      if (!existsSync(file)) {
        return new Response(`Not found: ${name}`, { status: 404 });
      }
      return net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });

  // User data: ~/.grokdeck (migrates from ~/.grok-deck if present)
  ensureDeckHome();
  void themesDir();

  registerIpc();
  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  void agent.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void agent.stop();
});
