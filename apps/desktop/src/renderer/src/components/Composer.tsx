import { memo, useEffect, useMemo, useState } from "react";
import type {
  AppSettings,
  ChatAttachment,
  DeckMode,
  SlashCommand,
  ThemeId,
  WorkspaceFileEntry,
} from "@grok-deck/shared";
import {
  REASONING_EFFORTS,
  THEMES,
  deckModeLabel,
  type ReasoningEffort,
} from "@grok-deck/shared";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function looksLikePastedCode(text: string): boolean {
  if (/```/.test(text)) return false;
  const lines = text.split(/\r?\n/);
  if (lines.length < 5) return false;
  const hits = lines.filter((l) =>
    /^\s*(import |from |const |let |var |function |class |def |export |if \(|for \(|while \(|return |#include|using |package |<\/?[a-zA-Z]|{\s*$|};\s*$)/.test(
      l,
    ),
  ).length;
  return hits >= 3;
}

function maybeFenceCode(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed || !looksLikePastedCode(trimmed)) return text;
  return `\`\`\`\n${trimmed}\n\`\`\``;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export const Composer = memo(function Composer({
  busy,
  canType,
  authReady,
  projectRoot,
  mode,
  settings,
  slashCmds,
  onSubmit,
  onCancel,
  onCycleMode,
  onSetEffort,
  onSetTheme,
  onRunSlash,
  onStatus,
  onQueue,
  seedText,
  seedNonce,
}: {
  busy: boolean;
  canType: boolean;
  authReady: boolean;
  projectRoot: string | null;
  mode: DeckMode;
  settings: AppSettings;
  slashCmds: SlashCommand[];
  onSubmit: (text: string, attachments: ChatAttachment[]) => void;
  onCancel: () => void;
  onCycleMode: () => void;
  onSetEffort: (effort: ReasoningEffort) => void;
  onSetTheme: (theme: ThemeId) => void;
  onRunSlash: (cmd: SlashCommand) => void;
  onStatus: (msg: string) => void;
  onQueue?: (text: string) => void;
  seedText?: string;
  seedNonce?: number;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionHits, setMentionHits] = useState<WorkspaceFileEntry[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    if (seedNonce && seedText) setDraft(seedText);
  }, [seedNonce, seedText]);

  const filteredSlash = useMemo(() => {
    const q = slashFilter.replace(/^\//, "").toLowerCase();
    if (!q) return slashCmds;
    return slashCmds.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        (c.kind === "skill" && "skill".includes(q)),
    );
  }, [slashCmds, slashFilter]);

  function addAttachments(list: ChatAttachment[]) {
    if (!list.length) return;
    setAttachments((prev) => {
      const map = new Map(prev.map((a) => [a.path.toLowerCase(), a]));
      for (const a of list) map.set(a.path.toLowerCase(), a);
      return [...map.values()];
    });
  }

  function pathsFromFileList(files: FileList | null | undefined): string[] {
    if (!files?.length) return [];
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f) continue;
      const p = window.grokDeck.attachments.pathForFile(f);
      if (p) paths.push(p);
    }
    return paths;
  }

  async function onPickAttachments() {
    try {
      const res = await window.grokDeck.attachments.pick();
      if (!res.ok && res.message) onStatus(res.message);
      if (res.attachments?.length) {
        addAttachments(res.attachments);
        onStatus(`${res.attachments.length}개 파일 첨부`);
      }
    } catch (err) {
      onStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function onPaste(e: React.ClipboardEvent) {
    const cd = e.clipboardData;
    if (!cd) return;

    const imageFiles: File[] = [];
    if (cd.items) {
      for (let i = 0; i < cd.items.length; i++) {
        const it = cd.items[i];
        if (!it || !it.type.startsWith("image/")) continue;
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (!imageFiles.length && cd.files?.length) {
      for (let i = 0; i < cd.files.length; i++) {
        const f = cd.files[i];
        if (f?.type.startsWith("image/")) imageFiles.push(f);
      }
    }

    if (imageFiles.length) {
      e.preventDefault();
      for (const file of imageFiles) {
        const path = window.grokDeck.attachments.pathForFile(file);
        if (path) {
          const atts = await window.grokDeck.attachments.fromPaths([path]);
          addAttachments(atts);
          continue;
        }
        try {
          const data = await fileToBase64(file);
          const res = await window.grokDeck.attachments.fromClipboardImage({
            mimeType: file.type || "image/png",
            data,
            name: file.name,
          });
          if (res && "id" in res && res.id) {
            addAttachments([res]);
          } else if (res && "error" in res) {
            onStatus(res.error);
          }
        } catch (err) {
          onStatus(err instanceof Error ? err.message : String(err));
        }
      }
      onStatus(`이미지 ${imageFiles.length}개 붙여넣음`);
      return;
    }

    const paths = pathsFromFileList(cd.files);
    if (!paths.length) return;
    e.preventDefault();
    const atts = await window.grokDeck.attachments.fromPaths(paths);
    addAttachments(atts);
  }

  async function onDropFiles(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsFromFileList(e.dataTransfer?.files);
    if (paths.length) {
      const atts = await window.grokDeck.attachments.fromPaths(paths);
      addAttachments(atts);
      return;
    }
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f?.type.startsWith("image/")) continue;
      const data = await fileToBase64(f);
      const res = await window.grokDeck.attachments.fromClipboardImage({
        mimeType: f.type || "image/png",
        data,
        name: f.name,
      });
      if (res && "id" in res && res.id) addAttachments([res]);
    }
  }

  function updateMentionFromDraft(value: string, caret = value.length) {
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|[\s\n])@([^\s@]*)$/);
    if (m) {
      setMentionOpen(true);
      setMentionFilter(m[1] || "");
      setSlashOpen(false);
    } else {
      setMentionOpen(false);
      setMentionFilter("");
    }
  }

  useEffect(() => {
    if (!mentionOpen || !projectRoot) {
      setMentionHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void window.grokDeck.workspace
        .searchFiles(mentionFilter, projectRoot || undefined)
        .then((hits) => {
          if (!cancelled) setMentionHits(hits);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mentionOpen, mentionFilter, projectRoot]);

  function insertMention(file: WorkspaceFileEntry) {
    setDraft((prev) => {
      const m = prev.match(/^(.*(?:^|[\s\n]))@([^\s@]*)$/s);
      if (m) return `${m[1]}@${file.relative} `;
      const idx = prev.lastIndexOf("@");
      if (idx >= 0) {
        const afterAt = prev.slice(idx + 1);
        if (!/\s/.test(afterAt)) return `${prev.slice(0, idx)}@${file.relative} `;
      }
      return `${prev}${prev.endsWith(" ") || !prev ? "" : " "}@${file.relative} `;
    });
    setMentionOpen(false);
    void window.grokDeck.attachments.fromPaths([file.path]).then(addAttachments);
  }

  function queueDraft() {
    const t = maybeFenceCode(draft).trim();
    if (!t || !onQueue) return false;
    onQueue(t);
    setDraft("");
    setAttachments([]);
    setSlashOpen(false);
    setMentionOpen(false);
    setConfigOpen(false);
    return true;
  }

  function send() {
    const text = maybeFenceCode(draft);
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (busy) {
      queueDraft();
      return;
    }
    const pending = [...attachments];
    setDraft("");
    setAttachments([]);
    setSlashOpen(false);
    setMentionOpen(false);
    setConfigOpen(false);
    onSubmit(trimmed, pending);
  }

  return (
    <div className="composer-wrap">
      <div
        className="composer"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => void onDropFiles(e)}
      >
        {slashOpen ? (
          <div className="slash-menu">
            {filteredSlash.length === 0 ? (
              <div className="slash-empty">일치하는 명령/스킬 없음</div>
            ) : (
              filteredSlash.slice(0, 16).map((c) => (
                <button
                  key={`${c.kind || "cmd"}:${c.name}`}
                  type="button"
                  className="slash-item"
                  onClick={() => {
                    setSlashOpen(false);
                    setDraft("");
                    onRunSlash(c);
                  }}
                >
                  <span className="slash-name">
                    /{c.name}
                    {c.kind === "skill" ? <span className="slash-badge">skill</span> : null}
                  </span>
                  <span className="slash-desc">{c.description}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {mentionOpen ? (
          <div className="slash-menu mention-menu">
            {mentionHits.length === 0 ? (
              <div className="slash-empty">
                {projectRoot ? "파일 없음 · 다른 이름 입력" : "프로젝트를 먼저 여세요"}
              </div>
            ) : (
              mentionHits.slice(0, 12).map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className="slash-item"
                  onClick={() => insertMention(f)}
                >
                  <span className="slash-name">@{f.name}</span>
                  <span className="slash-desc">{f.relative}</span>
                </button>
              ))
            )}
          </div>
        ) : null}
        {configOpen ? (
          <div className="config-menu">
            <div className="config-section">
              <div className="config-label">모델</div>
              <div className="config-row">
                <strong>{settings.model}</strong>
              </div>
            </div>
            <div className="config-section">
              <div className="config-label">추론 강도</div>
              {REASONING_EFFORTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`config-opt ${settings.reasoningEffort === e.id ? "active" : ""}`}
                  onClick={() => onSetEffort(e.id)}
                >
                  <span>{e.label}</span>
                  {settings.reasoningEffort === e.id ? <span>✓</span> : null}
                </button>
              ))}
            </div>
            <div className="config-section">
              <div className="config-label">테마</div>
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`config-opt ${settings.theme === t.id ? "active" : ""}`}
                  onClick={() => onSetTheme(t.id)}
                >
                  <span>{t.label}</span>
                  {settings.theme === t.id ? <span>✓</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="attach-strip">
            {attachments.map((a) => (
              <div key={a.id} className={`attach-chip ${a.kind}`}>
                {a.kind === "image" && a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} className="attach-thumb" />
                ) : (
                  <span className="attach-file-icon">📄</span>
                )}
                <div className="attach-meta">
                  <span className="attach-name" title={a.path}>
                    {a.name}
                  </span>
                  <span className="attach-sub">
                    {a.kind === "image" ? "이미지" : "파일"}
                    {a.size != null ? ` · ${formatBytes(a.size)}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className="attach-remove"
                  title="제거"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          value={draft}
          placeholder={
            !authReady
              ? "Grok 로그인 후 메시지를 입력하세요…"
              : !projectRoot
                ? "프로젝트를 연 뒤 작업을 입력하세요…"
                : busy
                  ? "작업 중 · 입력 후 큐에 넣기 (Ctrl+Enter)"
                  : "메시지 · / 스킬·명령 · @ 파일 멘션 · Ctrl+V 이미지 붙여넣기…"
          }
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            const caret = e.target.selectionStart ?? v.length;
            if (v.startsWith("/") && !v.includes("\n")) {
              setSlashOpen(true);
              setSlashFilter(v);
              setConfigOpen(false);
              setMentionOpen(false);
            } else {
              setSlashOpen(false);
              setSlashFilter("");
              updateMentionFromDraft(v, caret);
            }
          }}
          onPaste={(e) => void onPaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (busy || e.shiftKey) queueDraft();
              else send();
            }
            if (e.key === "Tab" && e.shiftKey) {
              e.preventDefault();
              onCycleMode();
            }
            if (e.key === "Escape") {
              if (busy) {
                e.preventDefault();
                onCancel();
                return;
              }
              setSlashOpen(false);
              setMentionOpen(false);
              setConfigOpen(false);
            }
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && slashOpen && filteredSlash[0]) {
              e.preventDefault();
              const cmd = filteredSlash[0];
              setSlashOpen(false);
              setDraft("");
              onRunSlash(cmd);
            }
            if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && mentionOpen && mentionHits[0]) {
              e.preventDefault();
              insertMention(mentionHits[0]);
            }
          }}
          disabled={!authReady}
        />
        <div className="composer-bar">
          <div className="composer-left">
            <button
              type="button"
              className="btn-icon"
              title="파일 첨부"
              onClick={() => void onPickAttachments()}
              disabled={!authReady}
            >
              📎
            </button>
            <button
              type="button"
              className="config-trigger"
              onClick={() => {
                setConfigOpen((v) => !v);
                setSlashOpen(false);
                setMentionOpen(false);
              }}
            >
              {settings.model} · {settings.reasoningEffort} ▾
            </button>
            <span className="sep">·</span>
            <span>{deckModeLabel(mode)}</span>
          </div>
          <div className="composer-right">
            {onQueue ? (
              <button
                type="button"
                className="btn-queue"
                disabled={!draft.trim()}
                title="큐에 넣기 (Ctrl+Shift+Enter)"
                onClick={() => {
                  queueDraft();
                }}
              >
                큐
              </button>
            ) : null}
            {busy ? (
              <button type="button" className="btn" onClick={onCancel}>
                취소
              </button>
            ) : null}
            <button
              className="btn-send"
              disabled={!draft.trim() && attachments.length === 0}
              onClick={send}
              title={busy ? "작업 중 · 큐에 넣기 (Ctrl+Enter)" : "Ctrl+Enter"}
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
