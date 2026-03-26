import { Skeleton } from './skeleton';

interface PageLoadingSkeletonProps {
  /** Number of content blocks to show (default: 4) */
  lines?: number;
}

export function PageLoadingSkeleton({ lines = 4 }: PageLoadingSkeletonProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="rounded-xl border-0 bg-surface p-6 shadow-none">
        <div className="space-y-4">
          {Array.from({ length: lines }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
