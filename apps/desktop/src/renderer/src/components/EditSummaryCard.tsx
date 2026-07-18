import { useMemo, useState } from "react";
import type { GhostFileStat, ToolCallView } from "@grok-deck/shared";
import { isEditTool } from "@grok-deck/shared";

function fileName(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function shortPath(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function statsFor(
  diff: { path: string; oldText?: string | null; newText: string },
): { path: string; add: number; del: number } {
  const oldN = (diff.oldText ?? "").split(/\r?\n/).filter(Boolean).length;
  const newN = diff.newText.split(/\r?\n/).filter(Boolean).length;
  if (!diff.oldText) return { path: diff.path, add: Math.max(newN, 1), del: 0 };
  return {
    path: diff.path,
    add: Math.max(0, newN - Math.min(oldN, newN)),
    del: Math.max(0, oldN - Math.min(oldN, newN)),
  };
}

export function EditSummaryCard({
  tools,
  files,
  onReview,
  onUndo,
  canUndo = false,
  undoing = false,
}: {
  tools: ToolCallView[];
  /** Preferred: per-turn Ghost Git stats (this message only) */
  files?: GhostFileStat[];
  onReview?: (path?: string) => void;
  onUndo?: () => void;
  canUndo?: boolean;
  undoing?: boolean;
}) {
  const edits = tools.filter(isEditTool);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    // Ghost commit stats for THIS turn take priority (true incremental diff)
    if (files && files.length > 0) {
      return files.map((f) => ({
        path: f.path,
        add: f.add || 0,
        del: f.del || 0,
      }));
    }

    const map = new Map<string, { path: string; add: number; del: number }>();
    for (const t of edits) {
      if (t.diffs?.length) {
        for (const d of t.diffs) {
          const s = statsFor(d);
          const prev = map.get(s.path);
          if (prev) {
            // Same path touched multiple times in one turn: sum deltas
            prev.add += s.add;
            prev.del += s.del;
          } else map.set(s.path, s);
        }
      } else {
        const loc = t.locations?.[0]?.path;
        const title = t.title || t.tool || "edit";
        const m = title.match(/[`'"]([^`'"]+)[`'"]/);
        const path = loc || m?.[1] || title;
        if (!map.has(path)) map.set(path, { path, add: 0, del: 0 });
      }
    }
    return [...map.values()];
  }, [edits, files]);

  if (!rows.length && !edits.length) return null;

  const totalAdd = rows.reduce((a, r) => a + r.add, 0);
  const totalDel = rows.reduce((a, r) => a + r.del, 0);
  const visible = showAll ? rows : rows.slice(0, 5);

  return (
    <div className="edit-summary">
      <div className="edit-summary-head">
        <button type="button" className="edit-summary-title" onClick={() => setOpen((v) => !v)}>
          <span className="edit-icon">📄</span>
          <span>파일 {rows.length || edits.length}개를 편집했습니다</span>
          {(totalAdd > 0 || totalDel > 0) && (
            <span className="edit-stats">
              <span className="add">+{totalAdd}</span>{" "}
              <span className="del">-{totalDel}</span>
            </span>
          )}
        </button>
        <div className="edit-summary-actions">
          <button
            type="button"
            className="btn btn-sm"
            title={
              canUndo
                ? "고스트 Git: 이 메시지의 파일 변경을 되돌립니다"
                : "되돌리기는 가장 최근 편집 메시지에서만 가능합니다"
            }
            disabled={!canUndo || undoing || !onUndo}
            onClick={() => onUndo?.()}
          >
            {undoing ? "되돌리는 중…" : "실행 취소"}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => onReview?.(rows[0]?.path)}>
            리뷰
          </button>
        </div>
      </div>
      {open ? (
        <>
          {visible.map((r) => (
            <button
              type="button"
              key={r.path}
              className="edit-file-row"
              onClick={() => onReview?.(r.path)}
              title={r.path}
            >
              <span className="edit-file-name">{shortPath(r.path) || fileName(r.path)}</span>
              <span className="edit-file-delta">
                {r.add || r.del ? (
                  <>
                    <span className="add">+{r.add}</span>{" "}
                    <span className="del">-{r.del}</span>
                  </>
                ) : (
                  <span className="muted">edit</span>
                )}
              </span>
            </button>
          ))}
          {rows.length > 5 ? (
            <button type="button" className="edit-more" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "파일 접기 ˄" : `${rows.length - 5}개 더 보기 ˅`}
            </button>
          ) : rows.length > 0 ? (
            <button type="button" className="edit-more" onClick={() => setOpen(false)}>
              파일 접기 ˄
            </button>
          ) : null}
        </>
      ) : (
        <button type="button" className="edit-more" onClick={() => setOpen(true)}>
          파일 펼치기 ˅
        </button>
      )}
    </div>
  );
}
