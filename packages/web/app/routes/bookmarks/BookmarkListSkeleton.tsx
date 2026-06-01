import { SkeletonList } from "@slugbase/ui";

export function BookmarkListSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">
      <div className="flex flex-col gap-sp-3">
        <div className="h-8 w-48 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
        <div className="h-4 w-64 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
      </div>
      <SkeletonList rows={8} testId="bookmark-list-skeleton" />
    </div>
  );
}
