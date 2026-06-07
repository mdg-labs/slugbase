import type { ReactNode } from "react";

export type ListPageToolbarProps = {
  children: ReactNode;
  className?: string;
  testId?: string;
};

/** Prototype `.toolbar` — hairline bottom, sp-7 horizontal padding. */
export function ListPageToolbar({
  children,
  className = "",
  testId,
}: ListPageToolbarProps) {
  return (
    <div
      className={`flex flex-wrap items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-7 py-sp-5 ${className}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Prototype `.toolbar-spacer` */
export function ListPageToolbarSpacer() {
  return <div className="flex-1" />;
}
