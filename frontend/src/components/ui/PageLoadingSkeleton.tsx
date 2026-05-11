import { Skeleton } from './skeleton';

interface PageLoadingSkeletonProps {
  /** Number of content blocks to show (default: 4) */
  lines?: number;
}

export function PageLoadingSkeleton({ lines = 4 }: PageLoadingSkeletonProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48 rounded-[var(--radius)]" />
        <Skeleton className="h-4 max-w-md rounded-[var(--radius-sm)]" />
      </div>
      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 sm:p-6">
        <div className="space-y-4">
          {Array.from({ length: lines }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      </div>
    </div>
  );
}
