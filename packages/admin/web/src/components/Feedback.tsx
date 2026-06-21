import type { CSSProperties, ReactNode } from "react";

const panelStyle: CSSProperties = {
  padding: "var(--sp-6)",
  background: "var(--raised)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  textAlign: "center",
};

const messageStyle: CSSProperties = {
  margin: 0,
  color: "var(--danger-text)",
  fontSize: "var(--text-sm)",
};

const buttonStyle: CSSProperties = {
  marginTop: "var(--sp-4)",
  padding: "var(--sp-2) var(--sp-4)",
  background: "var(--accent)",
  color: "#0b0c14",
  border: "none",
  borderRadius: "var(--radius-sm)",
  fontWeight: 500,
  fontSize: "var(--text-sm)",
};

export function ErrorRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div style={panelStyle} data-testid="error-retry">
      <p style={messageStyle}>{message}</p>
      <button type="button" style={buttonStyle} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function InlineErrorRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--sp-3)",
        padding: "var(--sp-3) var(--sp-4)",
        background: "var(--danger-subtle)",
        borderRadius: "var(--radius-sm)",
        fontSize: "var(--text-sm)",
      }}
      data-testid="inline-error-retry"
    >
      <span style={{ color: "var(--danger-text)", flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        style={{
          ...buttonStyle,
          marginTop: 0,
          padding: "var(--sp-1) var(--sp-3)",
        }}
      >
        Retry
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div style={panelStyle} data-testid="empty-state">
      <p style={{ margin: 0, fontWeight: 500 }}>{title}</p>
      {description !== undefined ? (
        <p style={{ margin: "var(--sp-2) 0 0", color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}
