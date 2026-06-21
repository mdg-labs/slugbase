import type { CSSProperties } from "react";

import { FREE_BOOKMARK_CAP } from "../api/types.js";

const trackStyle: CSSProperties = {
  height: 8,
  background: "var(--raised-2)",
  borderRadius: 999,
  overflow: "hidden",
  marginTop: "var(--sp-2)",
};

function utilizationTone(ratio: number): string {
  if (ratio >= 1) {
    return "var(--danger)";
  }
  if (ratio >= 0.8) {
    return "var(--warning)";
  }
  return "var(--success)";
}

export function BookmarkCapMeter({
  active,
  cap = FREE_BOOKMARK_CAP,
  archived,
  compact = false,
}: {
  active: number;
  cap?: number;
  archived?: number;
  compact?: boolean;
}) {
  const ratio = cap > 0 ? active / cap : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const tone = utilizationTone(ratio);

  return (
    <div data-testid="bookmark-cap-meter">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: compact ? "var(--text-xs)" : "var(--text-sm)",
          color: "var(--fg-muted)",
        }}
      >
        <span>
          {active} / {cap} bookmarks
        </span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{percent}%</span>
      </div>
      <div style={trackStyle} aria-hidden>
        <div
          style={{
            width: `${String(percent)}%`,
            height: "100%",
            background: tone,
            borderRadius: 999,
          }}
        />
      </div>
      {archived !== undefined && archived > 0 ? (
        <p
          style={{
            margin: "var(--sp-1) 0 0",
            fontSize: "var(--text-xs)",
            color: "var(--fg-subtle)",
          }}
        >
          {archived} plan-archived
        </p>
      ) : null}
    </div>
  );
}
