import type { ReactNode } from "react";

export type ListPageSplitProps = {
  /** When true and panel is provided, show a 360px detail column */
  panelOpen?: boolean;
  list: ReactNode;
  panel?: ReactNode;
  className?: string;
  testId?: string;
};

/**
 * Tags master–detail layout — prototype `.tags-layout` (1fr + 360px panel).
 */
export function ListPageSplit({
  panelOpen = false,
  list,
  panel,
  className = "",
  testId,
}: ListPageSplitProps) {
  const showPanel = panelOpen && panel != null;

  return (
    <div
      className={`grid min-h-0 flex-1 overflow-hidden ${className}`}
      style={{
        gridTemplateColumns: showPanel ? "1fr 360px" : "1fr",
      }}
      data-testid={testId}
    >
      <div className="min-h-0 overflow-y-auto">{list}</div>
      {showPanel ? (
        <div className="min-h-0 overflow-y-auto border-l border-[color:var(--border-subtle)]">
          {panel}
        </div>
      ) : null}
    </div>
  );
}
