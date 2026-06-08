export function BookmarkListSkeleton() {
  return (
    <div className="p-sp-7" data-testid="bookmark-list-skeleton">
      <div
        className="grid gap-sp-5"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        }}
      >
        {Array.from({ length: 9 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-sp-4 rounded-lg border border-[color:var(--border)] bg-raised p-sp-5"
            aria-hidden="true"
          >
            {/* Favicon + title row */}
            <div className="flex items-start gap-sp-3">
              <div className="h-8 w-8 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="flex-1 space-y-sp-2">
                <div className="h-[14px] w-3/4 animate-pulse rounded bg-[color:var(--border)]" />
              </div>
            </div>
            {/* URL row */}
            <div className="h-3 w-2/3 animate-pulse rounded bg-[color:var(--border)]" />
            {/* Slug row */}
            <div className="h-[18px] w-24 animate-pulse rounded bg-[color:var(--border)]" />
            {/* Meta row */}
            <div className="flex items-center gap-sp-3">
              <div className="h-3 w-16 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="h-4 w-12 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="ml-auto h-3 w-8 animate-pulse rounded bg-[color:var(--border)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}