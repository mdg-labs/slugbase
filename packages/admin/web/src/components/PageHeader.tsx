import type { CSSProperties, ReactNode } from "react";

const headerStyle: CSSProperties = {
  marginBottom: "var(--sp-6)",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xl)",
  fontWeight: 600,
};

const subtitleStyle: CSSProperties = {
  margin: "var(--sp-2) 0 0",
  color: "var(--fg-muted)",
  fontSize: "var(--text-sm)",
};

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header style={{ ...headerStyle, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--sp-4)" }}>
      <div>
        <h2 style={titleStyle}>{title}</h2>
        {subtitle !== undefined ? <p style={subtitleStyle}>{subtitle}</p> : null}
      </div>
      {actions !== undefined ? <div>{actions}</div> : null}
    </header>
  );
}
