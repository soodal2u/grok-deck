import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolCallView } from "@grok-deck/shared";
import { isEditTool } from "@grok-deck/shared";
import { ToolChip } from "./ToolChip";

function toolLabel(t: ToolCallView): string {
  const raw = (t.title || t.tool || t.kind || "tool").trim();
  // Collapse noisy call-… ids into a short verb
  if (/^call-[a-f0-9-]+$/i.test(raw)) {
    if (isEditTool(t)) return "파일 편집";
    if (/search|web/i.test(`${t.kind} ${t.tool}`)) return "검색";
    return "도구 실행";
  }
  // Truncate long titles
  return raw.length > 64 ? `${raw.slice(0, 62)}…` : raw;
}

function statusVerb(t: ToolCallView): string {
  if (t.status === "completed") return "완료";
  if (t.status === "failed") return "실패";
  if (t.status === "cancelled") return "취소";
  if (t.status === "in_progress") return "진행 중";
  return "대기";
}

function iconFor(t: ToolCallView): string {
  const k = `${t.kind || ""} ${t.title || ""} ${t.tool || ""}`.toLowerCase();
  if (isEditTool(t)) return "✎";
  if (/web.?search|search|grep|list|read|glob/.test(k)) return "◎";
  if (/shell|bash|terminal|execute|run/.test(k)) return "›";
  return "•";
}

/**
 * Compact in-chat "toast" for live tool calls.
 * Collapsed by default so assistant text stays visible; click to expand full chips.
 */
export function LiveToolToast({ tools }: { tools: ToolCallView[] }) {
  const [expanded, setExpanded] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const summary = useMemo(() => {
    if (!tools.length) return null;
    const running = tools.filter((t) => t.status === "pending" || t.status === "in_progress");
    const failed = tools.filter((t) => t.status === "failed").length;
    const done = tools.filter((t) => t.status === "completed").length;
    const active = running[running.length - 1] || tools[tools.length - 1]!;
    return {
      running: running.length,
      failed,
      done,
      total: tools.length,
      active,
      label: toolLabel(active),
      icon: iconFor(active),
      verb: statusVerb(active),
    };
  }, [tools]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!expanded || !el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [tools, expanded]);

  if (!summary) return null;

  const headline =
    summary.running > 0
      ? `${summary.icon} ${summary.label}`
      : summary.failed > 0
        ? `도구 ${summary.total}개 · 실패 ${summary.failed}`
        : `도구 ${summary.total}개 완료`;

  const sub =
    summary.running > 0
      ? `${summary.verb} · ${summary.done}/${summary.total} 완료${
          summary.failed ? ` · 실패 ${summary.failed}` : ""
        }`
      : expanded
        ? "목록을 스크롤해서 도구를 확인하세요"
        : summary.failed
          ? "클릭해서 상세 보기"
          : "클릭해서 펼치기";

  return (
    <div className={`live-tool-toast ${expanded ? "open" : "collapsed"}`}>
      <button
        type="button"
        className="live-tool-toast-bar"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "도구 목록 접기" : "도구 목록 펼치기"}
      >
        <span className="ltt-pulse" data-active={summary.running > 0 ? "1" : "0"} />
        <span className="ltt-main">
          <span className="ltt-headline">{headline}</span>
          <span className="ltt-sub">{sub}</span>
        </span>
        <span className="ltt-count">{summary.total}</span>
        <span className="ltt-chev">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded ? (
        <div
          className="live-tool-toast-body"
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current;
            if (!el) return;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {tools.map((t) => (
            <ToolChip key={t.id} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
