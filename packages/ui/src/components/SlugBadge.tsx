import type { ReactNode } from "react";

export type SlugBadgeProps = {
  slug: string;
  icon?: ReactNode;
  className?: string;
};

/**
 * Inline slug address pill - accent-subtle bg, mono small font.
 * Matches prototype `.slug-line` pattern from app.css.
 * Used on bookmark cards and table rows.
 */
export function SlugBadge({ slug, icon, className = "" }: SlugBadgeProps) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-[6px] rounded-sm border border-[color:var(--accent-border)] bg-accent-subtle text-accent-text ${className}`}
      style={{
        height: "22px",
        padding: "0 7px 0 6px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-small)",
        fontWeight: "var(--weight-medium)",
        lineHeight: "1",
      }}
    >
      {icon ? (
        <span aria-hidden="true" className="shrink-0 opacity-80">
          {icon}
        </span>
      ) : null}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">{slug}</span>
    </span>
  );
}
