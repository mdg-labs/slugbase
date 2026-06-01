import type { ReactNode } from "react";

export type TagProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Tag pill — `#` prefix at 45% opacity, mono micro font.
 * Matches prototype `.tag` pattern from app.css.
 */
export function Tag({ children, className = "" }: TagProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-[color:var(--border-subtle)] bg-raised-2 text-fg-muted ${className}`}
      style={{
        height: "19px",
        padding: "0 7px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-micro)",
        fontWeight: "var(--weight-medium)",
        lineHeight: "1",
      }}
    >
      <span aria-hidden="true" style={{ opacity: 0.45 }}>
        #
      </span>
      {children}
    </span>
  );
}
