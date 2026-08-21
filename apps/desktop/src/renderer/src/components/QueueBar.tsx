import { useState } from "react";
import type { QueuedMessage } from "@grok-deck/shared";

export function QueueBar({
  items,
  busy,
  onEdit,
  onRemove,
  onRun,
}: {
  items: QueuedMessage[];
  busy: boolean;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onRun: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (!items.length) return null;

  return (
    <div className="queue-bar">
      <div className="queue-bar-head">
        <span>다음 메시지 큐</span>
        <span className="queue-count">{items.length}</span>
      </div>
      <ul className="queue-list">
        {items.map((q, i) => (
          <li key={q.id} className="queue-item">
            {editingId === q.id ? (
              <div className="queue-edit">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  autoFocus
                />
                <div className="queue-item-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      if (draft.trim()) onEdit(q.id, draft.trim());
                      setEditingId(null);
                    }}
                  >
                    저장
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)}>
                    닫기
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span className="queue-index">{i + 1}</span>
                <span className="queue-text" title={q.text}>
                  {q.text}
                </span>
                <div className="queue-item-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    title={busy && i === 0 ? "현재 턴이 끝나면 바로 이어서 실행" : "지금 이 메시지 실행"}
                    onClick={() => onRun(q.id)}
                  >
                    {busy ? (i === 0 ? "다음" : "맨 앞") : "실행"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditingId(q.id);
                      setDraft(q.text);
                    }}
                  >
                    수정
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => onRemove(q.id)}>
                    삭제
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
