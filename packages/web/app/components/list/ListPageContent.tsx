import type { ReactNode } from "react";

export type ListPageContentProps = {
  children: ReactNode;
  className?: string;
  testId?: string;
};

/** Prototype `.content` — scrollable area with sp-7 padding. */
export function ListPageContent({
  children,
  className = "",
  testId,
}: ListPageContentProps) {
  return (
    <div
      className={`min-h-0 flex-1 overflow-y-auto px-sp-7 py-sp-7 ${className}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
