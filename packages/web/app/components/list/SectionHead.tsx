import { Badge } from "@slugbase/ui";
import type { ReactNode } from "react";

export type SectionHeadProps = {
  icon?: ReactNode;
  label: ReactNode;
  count?: number;
  className?: string;
  testId?: string;
};

/**
 * Prototype `.section-head` - pinned / all bookmarks section divider.
 */
export function SectionHead({
  icon,
  label,
  count,
  className = "",
  testId,
}: SectionHeadProps) {
  return (
    <div
      className={`mb-sp-5 mt-sp-3 flex items-center gap-sp-4 ${className}`}
      data-testid={testId}
    >
      {icon ? (
        <span className="shrink-0 text-accent-text">{icon}</span>
      ) : null}
      <span className="shrink-0 text-[length:var(--text-small)] font-medium uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      {count != null ? (
        <Badge variant="neutral">{count}</Badge>
      ) : null}
      <span className="h-px flex-1 bg-[color:var(--border-subtle)]" aria-hidden />
    </div>
  );
}
