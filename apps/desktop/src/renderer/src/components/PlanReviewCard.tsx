import { useMemo, useState } from "react";
import type { PlanDocument } from "@grok-deck/shared";
import { Markdown } from "./Markdown";

type Props = {
  plan: PlanDocument;
  busy?: boolean;
  onImplement: (notes: string) => void | Promise<void>;
  onRevise: (notes: string) => void | Promise<void>;
  onDismiss?: () => void;
};

function shortPath(p: string) {
  if (!p || p === "plan") return "plan.md";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

export function PlanReviewCard({ plan, busy, onImplement, onRevise, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(true);
  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState<"implement" | "revise" | null>(null);

  const preview = useMemo(() => {
    const lines = (plan.content || "").split(/\r?\n/);
    const head = lines.slice(0, 8).join("\n").trim();
    if (lines.length > 8) return `${head}\n…`;
    return head || "(empty plan)";
  }, [plan.content]);

  const entrySummary = plan.entries?.length
    ? plan.entries
        .slice(0, 6)
        .map((e, i) => `${i + 1}. ${e.content}`)
        .join("\n")
    : null;

  async function run(kind: "implement" | "revise") {
    if (acting || busy) return;
    if (kind === "revise" && !notes.trim()) return;
    setActing(kind);
    try {
      if (kind === "implement") await onImplement(notes);
      else await onRevise(notes);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="plan-review">
      <div className="plan-review-head">
        <div className="plan-review-title">
          <span className="plan-review-badge">Plan</span>
          <div>
            <strong>이 계획을 적용하시겠습니까?</strong>
            <div className="plan-review-path">{shortPath(plan.path)}</div>
          </div>
        </div>
        <div className="plan-review-head-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "접기" : "계획 펼치기"}
          </button>
          {onDismiss ? (
            <button type="button" className="btn btn-ghost" onClick={onDismiss} title="닫기">
              ×
            </button>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="plan-review-body">
          <div className="plan-review-md">
            <Markdown text={plan.content || entrySummary || preview} />
          </div>
        </div>
      ) : (
        <pre className="plan-review-preview">{entrySummary || preview}</pre>
      )}

      <label className="plan-review-notes-label">
        수정·추가 요청 (선택)
        <textarea
          className="plan-review-notes"
          rows={3}
          placeholder="예: Python 대신 Node로 구현, reports 폴더 대신 JSON 출력, 1차 소스만 먼저…"
          value={notes}
          disabled={!!acting || busy}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>

      <div className="plan-review-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!!acting || busy}
          onClick={() => void run("implement")}
        >
          {acting === "implement" ? "적용 중…" : "계획 적용 · 구현 시작"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!!acting || busy || !notes.trim()}
          onClick={() => void run("revise")}
          title="Plan 모드 유지 · 메모를 반영해 계획 수정"
        >
          {acting === "revise" ? "요청 중…" : "계획 수정 요청"}
        </button>
      </div>
      <p className="plan-review-hint">
        <strong>적용</strong>하면 Normal 모드로 전환 후 구현을 시작합니다.{" "}
        <strong>수정 요청</strong>은 Plan 모드를 유지한 채 계획만 다시 다듬습니다.
      </p>
    </div>
  );
}
