import type { CSSProperties } from "react";

import type { MetricsHistoryItem } from "../api/types.js";
import { EmptyState } from "./Feedback.js";

const panelStyle: CSSProperties = {
  background: "var(--raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  padding: "var(--sp-4)",
};

const titleStyle: CSSProperties = {
  margin: "0 0 var(--sp-4)",
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  color: "var(--fg-muted)",
};

function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  const month = parts[1] ?? "";
  const day = parts[2] ?? "";
  return `${month}/${day}`;
}

function SeriesChart({
  title,
  data,
  valueKey,
  color,
}: {
  title: string;
  data: MetricsHistoryItem[];
  valueKey: keyof Pick<
    MetricsHistoryItem,
    "newAccounts" | "newWorkspaces" | "totalBookmarks" | "activeSubscriptions"
  >;
  color: string;
}) {
  const chronological = [...data].reverse();
  const values = chronological.map((row) => row[valueKey]);
  const max = Math.max(1, ...values);
  const width = 320;
  const height = 120;
  const padding = 8;
  const barWidth = Math.max(
    4,
    (width - padding * 2) / Math.max(chronological.length, 1) - 2,
  );

  return (
    <div style={panelStyle}>
      <h3 style={titleStyle}>{title}</h3>
      {chronological.length === 0 ? (
        <EmptyState
          title="No snapshot data"
          description="Daily snapshots will appear after the rollup job runs."
        />
      ) : (
        <svg
          width="100%"
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          role="img"
          aria-label={title}
          data-testid={`chart-${valueKey}`}
        >
          {chronological.map((row, index) => {
            const value = row[valueKey];
            const barHeight = (value / max) * (height - padding * 2);
            const x = padding + index * (barWidth + 2);
            const y = height - padding - barHeight;
            return (
              <g key={row.snapshotDate}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill={color}
                  rx={2}
                />
                <title>
                  {row.snapshotDate}: {String(value)}
                </title>
              </g>
            );
          })}
        </svg>
      )}
      {chronological.length > 0 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: "var(--sp-2)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-subtle)",
            fontFamily: "var(--font-mono)",
          }}
        >
          <span>{formatShortDate(chronological[0]?.snapshotDate ?? "")}</span>
          <span>
            {formatShortDate(chronological[chronological.length - 1]?.snapshotDate ?? "")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function GrowthCharts({ items }: { items: MetricsHistoryItem[] }) {
  if (items.length === 0) {
    return (
      <div data-testid="growth-charts-empty">
        <EmptyState
          title="No growth history yet"
          description="Charts populate from admin.daily_snapshots after the nightly rollup."
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "var(--sp-4)",
        marginBottom: "var(--sp-6)",
      }}
      data-testid="growth-charts"
    >
      <SeriesChart
        title="New accounts / day"
        data={items}
        valueKey="newAccounts"
        color="var(--accent)"
      />
      <SeriesChart
        title="New workspaces / day"
        data={items}
        valueKey="newWorkspaces"
        color="var(--accent-text)"
      />
      <SeriesChart
        title="Total bookmarks"
        data={items}
        valueKey="totalBookmarks"
        color="var(--success)"
      />
      <SeriesChart
        title="Active subscriptions"
        data={items}
        valueKey="activeSubscriptions"
        color="var(--warning)"
      />
    </div>
  );
}

export function PlanMixChart({ items }: { items: MetricsHistoryItem[] }) {
  const latest = items[0];
  if (latest === undefined) {
    return (
      <div style={panelStyle} data-testid="plan-mix-chart-empty">
        <h3 style={titleStyle}>Plan mix (latest snapshot)</h3>
        <EmptyState title="No plan mix data" />
      </div>
    );
  }

  const segments = [
    { label: "Free", value: latest.workspacesByPlan.free, color: "var(--fg-subtle)" },
    { label: "Personal", value: latest.workspacesByPlan.personal, color: "var(--accent)" },
    { label: "Team", value: latest.workspacesByPlan.team, color: "var(--success)" },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (total === 0) {
    return (
      <div style={panelStyle} data-testid="plan-mix-chart-empty">
        <h3 style={titleStyle}>Plan mix (latest snapshot)</h3>
        <EmptyState title="No workspaces in snapshot" />
      </div>
    );
  }

  return (
    <div style={panelStyle} data-testid="plan-mix-chart">
      <h3 style={titleStyle}>Plan mix — {latest.snapshotDate}</h3>
      <div
        style={{
          display: "flex",
          height: 12,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--raised-2)",
        }}
      >
        {segments.map((segment) =>
          segment.value > 0 ? (
            <div
              key={segment.label}
              style={{
                width: `${String((segment.value / total) * 100)}%`,
                background: segment.color,
              }}
              title={`${segment.label}: ${String(segment.value)}`}
            />
          ) : null,
        )}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: "var(--sp-3) 0 0",
          padding: 0,
          display: "flex",
          gap: "var(--sp-4)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-muted)",
        }}
      >
        {segments.map((segment) => (
          <li key={segment.label}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 999,
                background: segment.color,
                marginRight: "var(--sp-1)",
              }}
            />
            {segment.label}: {segment.value}
          </li>
        ))}
      </ul>
    </div>
  );
}
