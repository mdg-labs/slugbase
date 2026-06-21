import type { CSSProperties } from "react";

const cardStyle: CSSProperties = {
  background: "var(--raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  padding: "var(--sp-4)",
};

const labelStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-subtle)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const valueStyle: CSSProperties = {
  margin: "var(--sp-2) 0 0",
  fontSize: "var(--text-xl)",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
};

const hintStyle: CSSProperties = {
  margin: "var(--sp-1) 0 0",
  fontSize: "var(--text-xs)",
  color: "var(--fg-muted)",
};

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div style={cardStyle}>
      <p style={labelStyle}>{label}</p>
      <p style={valueStyle}>{value}</p>
      {hint !== undefined ? <p style={hintStyle}>{hint}</p> : null}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        gap: "var(--sp-3)",
        marginBottom: "var(--sp-6)",
      }}
    >
      {children}
    </div>
  );
}
