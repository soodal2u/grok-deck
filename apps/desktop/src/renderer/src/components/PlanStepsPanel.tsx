import type { PlanEntry } from "@grok-deck/shared";

function normalizeStatus(s?: string): "completed" | "in_progress" | "pending" | "cancelled" {
  const v = (s || "").toLowerCase().replace(/[-\s]/g, "_");
  if (v === "completed" || v === "done" || v === "complete") return "completed";
  if (v === "in_progress" || v === "inprogress" || v === "running" || v === "active") {
    return "in_progress";
  }
  if (v === "cancelled" || v === "canceled" || v === "skipped") return "cancelled";
  return "pending";
}

function statusIcon(status: ReturnType<typeof normalizeStatus>): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "●";
    case "cancelled":
      return "–";
    default:
      return "○";
  }
}

export function PlanStepsPanel({
  entries,
  title,
}: {
  entries: PlanEntry[];
  title?: string;
}) {
  if (!entries.length) return null;

  const normalized = entries.map((e) => ({
    content: e.content,
    status: normalizeStatus(e.status),
    priority: e.priority,
  }));

  const done = normalized.filter((e) => e.status === "completed").length;
  const currentIdx = normalized.findIndex((e) => e.status === "in_progress");
  const phase =
    currentIdx >= 0
      ? currentIdx + 1
      : done >= normalized.length
        ? normalized.length
        : Math.min(done + 1, normalized.length);

  return (
    <div className="plan-steps-panel">
      <div className="plan-steps-head">
        <h4>{title || "작업 단계"}</h4>
        <span className="plan-steps-phase">
          {done}/{normalized.length}
          {currentIdx >= 0 ? ` · Phase ${phase}` : done === normalized.length ? " · 완료" : ""}
        </span>
      </div>
      <div className="plan-steps-track">
        <div
          className="plan-steps-fill"
          style={{ width: `${Math.round((done / normalized.length) * 100)}%` }}
        />
      </div>
      <ol className="plan-steps-list">
        {normalized.map((e, i) => (
          <li key={i} className={`plan-step status-${e.status}`}>
            <span className="plan-step-icon" aria-hidden>
              {statusIcon(e.status)}
            </span>
            <span className="plan-step-body">
              <span className="plan-step-text">{e.content}</span>
              <span className="plan-step-status">
                {e.status === "in_progress"
                  ? "진행 중"
                  : e.status === "completed"
                    ? "완료"
                    : e.status === "cancelled"
                      ? "건너뜀"
                      : "대기"}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
