import type { TokenUsage } from "@grok-deck/shared";
import { formatTokenCount } from "@grok-deck/shared";

export function ContextMeter({ usage }: { usage: TokenUsage | null }) {
  const used =
    usage?.totalTokens ??
    (usage?.inputTokens != null || usage?.outputTokens != null
      ? (usage.inputTokens || 0) + (usage.outputTokens || 0)
      : undefined);
  const limit = usage?.contextLimit || 500_000;
  const known = used != null;
  const pct = known ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;

  return (
    <div className="context-meter">
      <div className="context-meter-top">
        <span>Context</span>
        <span className="context-nums">
          {known ? formatTokenCount(used) : "—"} / {formatTokenCount(limit)}
        </span>
      </div>
      <div className="context-bar">
        <div className="context-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {usage?.inputTokens != null || usage?.outputTokens != null ? (
        <div className="context-sub">
          in {formatTokenCount(usage.inputTokens)} · out {formatTokenCount(usage.outputTokens)}
          {usage.cachedReadTokens ? ` · cache ${formatTokenCount(usage.cachedReadTokens)}` : ""}
        </div>
      ) : known ? (
        <div className="context-sub">이전 턴 사용량 · 전송 후 갱신</div>
      ) : (
        <div className="context-sub">세션 사용량은 첫 턴 이후 표시됩니다</div>
      )}
    </div>
  );
}
