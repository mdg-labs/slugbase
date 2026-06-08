export function FolderListSkeleton() {
  return (
    <div className="p-sp-7" data-testid="folder-list-skeleton">
      <div className="flex flex-col gap-sp-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-sp-4 rounded-lg px-sp-5 py-sp-4"
            aria-hidden="true"
          >
            {/* Color dot */}
            <span className="inline-block h-[10px] w-[10px] animate-pulse rounded bg-[color:var(--border)]" />
            {/* Name */}
            <div className="min-w-0 flex-1">
              <div className="h-[14px] w-3/5 animate-pulse rounded bg-[color:var(--border)]" />
            </div>
            {/* Count badge */}
            <div
              className="h-[12px] w-[30px] animate-pulse rounded bg-[color:var(--border)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            {/* Time */}
            <div className="h-[12px] w-16 animate-pulse rounded bg-[color:var(--border)]" />
          </div>
        ))}
      </div>
    </div>
  );
}