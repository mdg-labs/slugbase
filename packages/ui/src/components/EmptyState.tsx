import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  illustration?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  compact?: boolean;
};

/** Centered empty state — prototype `.empty` pattern (spec §23). */
export function EmptyState({
  title,
  description,
  illustration,
  actions,
  testId = "empty-state",
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={`mx-auto flex max-w-[420px] flex-col items-center justify-center text-center ${
        compact ? "gap-sp-4 px-sp-6 py-sp-8" : "gap-sp-5 px-sp-6 py-sp-10"
      }`}
      data-testid={testId}
    >
      {illustration ? (
        <div className="mb-sp-3 text-fg-faint" aria-hidden="true">
          {illustration}
        </div>
      ) : null}
      <h3
        className="m-0 font-semibold text-fg"
        style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
      >
        {title}
      </h3>
      {description ? (
        <p
          className="m-0 text-fg-subtle"
          style={{ fontSize: "var(--text-body-lg)", lineHeight: "1.5" }}
        >
          {description}
        </p>
      ) : null}
      {actions ? (
        <div className="mt-sp-3 flex flex-wrap items-center justify-center gap-sp-4">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
