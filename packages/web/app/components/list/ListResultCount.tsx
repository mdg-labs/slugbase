import type { ReactNode } from "react";

export type ListResultCountProps = {
  children: ReactNode;
  className?: string;
  testId?: string;
};

/** Mono result count — toolbar right cluster (prototype toolbar count span). */
export function ListResultCount({
  children,
  className = "",
  testId,
}: ListResultCountProps) {
  return (
    <span
      className={`shrink-0 font-mono text-[length:var(--text-small)] text-fg-subtle ${className}`}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
