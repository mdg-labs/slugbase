export function TagListSkeleton({ hasPanel = false }: { hasPanel?: boolean }) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="tag-list-skeleton">
      <div className="flex flex-1 flex-col">
        <div className="border-b border-[color:var(--border)] px-sp-6 py-sp-6">
          <div className="mb-sp-5 flex flex-col gap-sp-3">
            <div className="h-8 w-24 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
            <div className="h-4 w-40 animate-pulse rounded-sm bg-raised" aria-hidden="true" />
          </div>
          <div className="h-9 w-56 animate-pulse rounded-md bg-raised" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-sp-1 px-sp-6 py-sp-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="grid items-center gap-sp-5 rounded-md px-sp-4 py-sp-3"
              style={{ gridTemplateColumns: "1fr 180px 80px 80px" }}
              aria-hidden="true"
            >
              <div
                className="animate-pulse rounded bg-raised"
                style={{ height: 12, width: `${String(80 + i * 12)}px` }}
              />
              <div className="h-[5px] animate-pulse rounded-full bg-raised" />
              <div className="mx-auto h-3 w-7 animate-pulse rounded bg-raised" />
              <div className="ml-auto h-[22px] w-12 animate-pulse rounded-full bg-raised" />
            </div>
          ))}
        </div>
      </div>
      {hasPanel && (
        <div className="w-[360px] border-l border-[color:var(--border)]" aria-hidden="true" />
      )}
    </div>
  );
}
