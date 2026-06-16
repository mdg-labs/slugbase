export type FolderViewMode = "list" | "grid";

export function FolderListSkeleton({ view = "list" }: { view?: FolderViewMode }) {
  if (view === "grid") {
    return (
      <div className="p-sp-7" data-testid="folder-list-skeleton">
        <div
          className="grid gap-sp-4"
          style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-sp-3 rounded-lg border border-[color:var(--border)] bg-raised p-sp-4"
              aria-hidden="true"
            >
              <div className="h-6 w-6 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="h-[14px] w-4/5 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="h-[12px] w-1/2 animate-pulse rounded bg-[color:var(--border)]" />
              <div className="mt-sp-1 h-[10px] w-12 animate-pulse rounded bg-[color:var(--border)]" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-sp-7" data-testid="folder-list-skeleton">
      <div className="flex flex-col gap-sp-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-sp-5 rounded-lg px-sp-5 py-sp-4"
            aria-hidden="true"
          >
            <span className="inline-block h-[22px] w-[22px] animate-pulse rounded bg-[color:var(--border)]" />
            <div className="min-w-0 flex-1">
              <div className="h-[14px] w-3/5 animate-pulse rounded bg-[color:var(--border)]" />
            </div>
            <div
              className="h-[12px] w-[30px] animate-pulse rounded bg-[color:var(--border)]"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <div className="h-[12px] w-16 animate-pulse rounded bg-[color:var(--border)]" />
          </div>
        ))}
      </div>
    </div>
  );
}