import type { CSSProperties, ReactNode } from "react";

export type SkeletonProps = {
  className?: string;
  style?: CSSProperties;
  testId?: string;
  children?: ReactNode;
};

/** Shimmer placeholder block — prototype `.sk` pattern (spec §23). */
export function Skeleton({
  className = "",
  style,
  testId,
  children,
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-shimmer rounded-sm bg-[linear-gradient(90deg,var(--raised)_0%,var(--raised-2)_50%,var(--raised)_100%)] bg-[length:200%_100%] motion-reduce:animate-none ${className}`}
      data-testid={testId}
      style={style}
    >
      {children}
    </div>
  );
}

export type SkeletonListProps = {
  rows?: number;
  testId?: string;
};

/** Horizontal list-row skeletons for table/list surfaces. */
export function SkeletonList({ rows = 6, testId = "skeleton-list" }: SkeletonListProps) {
  return (
    <div className="flex flex-col gap-sp-3" data-testid={testId} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-center gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-raised px-sp-5 py-sp-5"
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-sp-3">
            <Skeleton className="h-3 w-[85%]" />
            <Skeleton className="h-2.5 w-[55%]" />
          </div>
          <Skeleton className="ml-auto h-8 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export type SkeletonCardGridProps = {
  count?: number;
  testId?: string;
};

/** Card grid skeleton matching bookmark grid loading state in the prototype. */
export function SkeletonCardGrid({
  count = 9,
  testId = "skeleton-card-grid",
}: SkeletonCardGridProps) {
  return (
    <div
      className="grid gap-sp-4 sm:grid-cols-2 lg:grid-cols-3"
      data-testid={testId}
      aria-busy="true"
      aria-live="polite"
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col gap-sp-5 rounded-lg border border-[color:var(--border-subtle)] bg-raised p-sp-5"
        >
          <div className="flex gap-sp-4">
            <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-sp-3">
              <Skeleton className="h-3 w-[85%]" />
              <Skeleton className="h-2.5 w-[55%]" />
            </div>
          </div>
          <Skeleton className="h-2.5 w-[70%]" />
          <Skeleton className="h-[22px] w-[120px] rounded-sm" />
          <div className="mt-sp-2 flex gap-sp-3">
            <Skeleton className="h-2.5 w-[70px]" />
            <Skeleton className="ml-auto h-4 w-10 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}
