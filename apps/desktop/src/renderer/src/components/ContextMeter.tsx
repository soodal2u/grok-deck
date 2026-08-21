import type { TokenUsage } from "@grok-deck/shared";
import { formatTokenCount } from "@grok-deck/shared";

type CompactInfo = {
  status: "idle" | "started" | "done" | "failed";
  before?: number;
  after?: number;
  at?: number;
  message?: string;
};

export function ContextMeter({
  usage,
  estimatedTokens,
  liveExtra = 0,
  live = false,
  compact,
  baseline,
}: {
  usage: TokenUsage | null;
  estimatedTokens?: number;
  /** Tokens added in the in-flight turn (chars/4 of live message + last user turn). */
  liveExtra?: number;
  live?: boolean;
  compact?: CompactInfo | null;
  /** Official used count captured at the start of the current turn */
  baseline?: number | null;
}) {
  const official =
    usage?.totalTokens ??
    (usage?.inputTokens != null || usage?.outputTokens != null
      ? (usage.inputTokens || 0) + (usage.outputTokens || 0)
      : undefined);
  const estimated = estimatedTokens && estimatedTokens > 0 ? estimatedTokens : undefined;
  const extra = live ? Math.max(0, liveExtra) : 0;
  const used = Math.max(
    official ?? 0,
    (baseline ?? official ?? 0) + extra,
    estimated ?? 0,
  );
  const fromEstimate = official == null && estimated != null;
  const known = official != null || estimated != null || extra > 0;
  const limit = usage?.contextLimit || 500_000;
  const remaining = known ? Math.max(0, limit - used) : undefined;
  const pct = known && limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  const nearLimit = known && pct >= 85;
  const compactedAt = usage?.compactedAt || (compact?.status === "done" ? compact.at : undefined);
  const compacting = compact?.status === "started";

  let sub: string;
  if (compacting) {
    sub = compact?.message || "자동 압축 진행 중…";
  } else if (compact?.status === "failed") {
    sub = compact.message || "압축 실패 · 다음 턴에서 재시도";
  } else if (live && known) {
    sub = fromEstimate
      ? `실시간 추정 · 남음 ${formatTokenCount(remaining)}`
      : `실시간 · 남음 ${formatTokenCount(remaining)}`;
  } else if (compactedAt) {
    const before = compact?.before ?? usage?.tokensBeforeCompact;
    const after = compact?.after ?? official;
    if (before != null && after != null) {
      sub = `정리됨 · ${formatTokenCount(before)} → ${formatTokenCount(after)} · 남음 ${formatTokenCount(remaining)}`;
    } else {
      sub = `Context 정리됨 · 남음 ${formatTokenCount(remaining)}`;
    }
  } else if (known) {
    sub = `남음 ${formatTokenCount(remaining)}`;
  } else {
    sub = "세션 사용량은 대화가 시작되면 표시됩니다";
  }

  const fillClass = compacting
    ? "compacting"
    : compactedAt && !live
      ? "compacted"
      : nearLimit
        ? "hot"
        : live
          ? "live"
          : "";

  return (
    <div
      className={`context-meter ${compacting ? "is-compacting" : compactedAt ? "is-compacted" : ""} ${live ? "is-live" : ""}`}
    >
      <div className="context-meter-top">
        <span>
          Context
          {live ? <span className="context-live-dot" title="실시간 갱신 중" /> : null}
        </span>
        <span className="context-nums">
          {known ? `${fromEstimate ? "~" : ""}${formatTokenCount(used)}` : "—"} / {formatTokenCount(limit)}
        </span>
      </div>
      <div className="context-bar">
        <div className={`context-bar-fill ${fillClass}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="context-stats">
        <span className="context-pct">{known ? `${pct.toFixed(pct >= 10 ? 0 : 1)}% 사용` : "—"}</span>
        <span className="context-remain">
          {remaining != null ? `남음 ${formatTokenCount(remaining)}` : "남음 —"}
        </span>
      </div>
      <div className={`context-sub ${compacting ? "live" : compactedAt && !live ? "ok" : nearLimit ? "warn" : live ? "live" : ""}`}>
        {sub}
      </div>
      {usage?.inputTokens != null || usage?.outputTokens != null ? (
        <div className="context-io">
          in {formatTokenCount(usage?.inputTokens)}
          {live && extra > 0 ? ` · +${formatTokenCount(extra)}` : ""}
          {usage?.outputTokens != null ? ` · out ${formatTokenCount(usage.outputTokens)}` : ""}
          {usage?.cachedReadTokens ? ` · cache ${formatTokenCount(usage.cachedReadTokens)}` : ""}
        </div>
      ) : null}
      {compactedAt && !live ? <div className="context-compact-flag">정리됨</div> : null}
    </div>
  );
}
