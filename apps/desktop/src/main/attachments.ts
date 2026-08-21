import { dialog, type BrowserWindow } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import type {
  ChatAttachment,
  ClipboardImagePayload,
  PromptAttachmentRef,
} from "@grok-deck/shared";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);

export function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".ts":
    case ".tsx":
      return "text/typescript";
    case ".js":
    case ".jsx":
      return "text/javascript";
    case ".py":
      return "text/x-python";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    default:
      return "application/octet-stream";
  }
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXT.has(extname(filePath).toLowerCase());
}

function uid(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Build a ChatAttachment with optional image preview (data URL). */
export async function buildAttachment(filePath: string): Promise<ChatAttachment> {
  const name = basename(filePath);
  const kind = isImagePath(filePath) ? "image" : "file";
  const mimeType = mimeFromPath(filePath);
  let size: number | undefined;
  let previewUrl: string | undefined;
  try {
    const st = await stat(filePath);
    size = st.size;
  } catch {
    /* ignore */
  }
  if (kind === "image") {
    try {
      // Cap preview at ~4MB raw to avoid huge renderer payloads
      if (size == null || size <= 4 * 1024 * 1024) {
        const buf = await readFile(filePath);
        previewUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
      }
    } catch {
      /* no preview */
    }
  }
  return {
    id: uid(),
    path: filePath,
    name,
    kind,
    mimeType,
    size,
    previewUrl,
  };
}

export async function pickAttachments(
  win: BrowserWindow | null,
): Promise<{ ok: boolean; attachments: ChatAttachment[]; message?: string }> {
  if (!win) return { ok: false, attachments: [], message: "No window" };
  const result = await dialog.showOpenDialog(win, {
    title: "파일 첨부",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
      {
        name: "Code & text",
        extensions: [
          "ts",
          "tsx",
          "js",
          "jsx",
          "py",
          "md",
          "json",
          "txt",
          "css",
          "html",
          "rs",
          "go",
          "java",
          "c",
          "cpp",
          "h",
          "yml",
          "yaml",
          "toml",
          "xml",
          "csv",
        ],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: true, attachments: [] };
  }
  const attachments: ChatAttachment[] = [];
  for (const p of result.filePaths) {
    try {
      attachments.push(await buildAttachment(p));
    } catch (err) {
      return {
        ok: false,
        attachments,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true, attachments };
}

export async function attachmentsFromPaths(paths: string[]): Promise<ChatAttachment[]> {
  const out: ChatAttachment[] = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      out.push(await buildAttachment(p));
    } catch {
      /* skip bad paths */
    }
  }
  return out;
}

function extFromMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("bmp")) return ".bmp";
  if (m.includes("svg")) return ".svg";
  return ".png";
}

/** Save a pasted screenshot / clipboard image and return a ChatAttachment. */
export async function attachmentFromClipboardImage(
  payload: ClipboardImagePayload,
): Promise<ChatAttachment> {
  const mime = payload.mimeType || "image/png";
  const ext = extFromMime(mime);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const dir = join(homedir(), ".grokdeck", "clipboard");
  await mkdir(dir, { recursive: true });
  const name = payload.name?.trim() || `clipboard-${stamp}${ext}`;
  const safeName = name.replace(/[<>:"/\\|?*]/g, "_");
  const filePath = join(dir, safeName.endsWith(ext) ? safeName : `${safeName}${ext}`);
  const buf = Buffer.from(payload.data, "base64");
  if (!buf.length) throw new Error("빈 클립보드 이미지");
  if (buf.length > 12 * 1024 * 1024) throw new Error("클립보드 이미지가 너무 큽니다 (12MB 제한)");
  await writeFile(filePath, buf);
  return buildAttachment(filePath);
}

/** ACP content blocks for session/prompt (images as base64, files as resource_link). */
export async function buildPromptContent(
  text: string,
  attachments: PromptAttachmentRef[] = [],
): Promise<Array<Record<string, unknown>>> {
  const blocks: Array<Record<string, unknown>> = [];

  const mentions: string[] = [];
  for (const a of attachments) {
    if (a.kind === "image") {
      try {
        const buf = await readFile(a.path);
        // ~8MB safety for model payload
        if (buf.length <= 8 * 1024 * 1024) {
          blocks.push({
            type: "image",
            data: buf.toString("base64"),
            mimeType: a.mimeType || mimeFromPath(a.path),
            uri: pathToFileUri(a.path),
          });
        }
        mentions.push(`[image: ${a.name}](${a.path})`);
      } catch {
        mentions.push(`[image missing: ${a.name}]`);
      }
    } else {
      blocks.push({
        type: "resource_link",
        uri: pathToFileUri(a.path),
        name: a.name,
        mimeType: a.mimeType || mimeFromPath(a.path),
        title: a.name,
      });
      mentions.push(`@${a.path}`);
    }
  }

  let body = text.trim();
  if (mentions.length && !mentions.every((m) => body.includes(m) || body.includes(m.replace(/^@/, "")))) {
    const extra = mentions.filter((m) => !body.includes(m)).join("\n");
    if (extra) body = body ? `${body}\n\n${extra}` : extra;
  }
  if (body) {
    blocks.unshift({ type: "text", text: body });
  } else if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

function pathToFileUri(p: string): string {
  // Windows: file:///C:/path
  const normalized = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${normalized}`;
  }
  if (normalized.startsWith("/")) return `file://${normalized}`;
  return `file:///${normalized}`;
}
