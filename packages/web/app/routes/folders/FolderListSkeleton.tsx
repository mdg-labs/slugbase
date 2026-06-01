import { SkeletonList } from "@slugbase/ui";

export function FolderListSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-sp-6 px-sp-6 py-sp-8">
      <div className="flex flex-col gap-sp-3">
        <div className="h-8 w-40 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
        <div className="h-4 w-56 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
      </div>
      <SkeletonList rows={6} testId="folder-list-skeleton" />
    </div>
  );
}
