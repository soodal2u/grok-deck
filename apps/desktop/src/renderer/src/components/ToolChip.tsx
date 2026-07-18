import { useState } from "react";
import type { ToolCallView } from "@grok-deck/shared";
import { isEditTool } from "@grok-deck/shared";

function formatPayload(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusClass(status: string): string {
  if (status === "completed") return "ok";
  if (status === "failed" || status === "cancelled") return "err";
  return "warn";
}

function toolIcon(t: ToolCallView): string {
  const k = `${t.kind || ""} ${t.title || ""} ${t.tool || ""}`.toLowerCase();
  if (isEditTool(t)) return "✎";
  if (/list|dir|read|grep|search/.test(k)) return "◎";
  if (/shell|bash|execute|terminal|run/.test(k)) return "›";
  return "•";
}

export function ToolChip({ tool, defaultOpen = false }: { tool: ToolCallView; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const title = tool.title || tool.tool || tool.id;
  const body = formatPayload(tool.input ?? tool.output ?? tool.content);

  return (
    <div className={`tool-chip status-${tool.status}`}>
      <button type="button" className="tool-chip-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-chip-icon">{toolIcon(tool)}</span>
        <span className="tool-chip-title">{title}</span>
        <span className={`badge ${statusClass(tool.status)}`}>{tool.status}</span>
        <span className="tool-chip-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && body ? (
        <pre className="tool-chip-body">{body}</pre>
      ) : null}
    </div>
  );
}

export function ToolGroup({
  tools,
  label,
  defaultCollapsed = true,
}: {
  tools: ToolCallView[];
  label?: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (!tools.length) return null;

  const failed = tools.filter((t) => t.status === "failed").length;
  const running = tools.filter((t) => t.status === "pending" || t.status === "in_progress").length;

  return (
    <div className="tool-group">
      <button type="button" className="tool-group-toggle" onClick={() => setCollapsed((v) => !v)}>
        <span className="tg-dot">{running ? "●" : failed ? "!" : "✓"}</span>
        <span>
          {label ||
            (running
              ? `도구 실행 중 ${tools.length}개`
              : failed
                ? `도구 ${tools.length}개 · 실패 ${failed}`
                : `도구 ${tools.length}개 사용`)}
        </span>
        <span className="tool-chip-chev">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed ? (
        <div className="tool-chip-stack">
          {tools.map((t) => (
            <ToolChip key={t.id} tool={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
