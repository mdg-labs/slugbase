import { BookmarkCard } from "../bookmarks/BookmarkCard.js";
import { useBookmarkCardActions } from "../bookmarks/use-bookmark-card-actions.js";
import type { DashboardBookmark } from "./dashboard.types.js";

const BOOKMARK_GRID_STYLE = {
  gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
} as const;

export type DashboardBookmarkGridProps = {
  bookmarks: DashboardBookmark[];
  onAfterMutation?: () => void;
};

export function DashboardBookmarkGrid({
  bookmarks,
  onAfterMutation,
}: DashboardBookmarkGridProps) {
  const {
    currentUserId,
    deleteDialog,
    handleOpenBookmark,
    handlePin,
    handleEdit,
    setDeleteTarget,
  } = useBookmarkCardActions({ onAfterMutation });

  return (
    <>
      <div className="grid gap-sp-5 p-sp-5" style={BOOKMARK_GRID_STYLE}>
        {bookmarks.map((bookmark) => (
          <BookmarkCard
            key={bookmark.id}
            bookmark={bookmark}
            selected={false}
            bulkSelectMode={false}
            onToggleSelect={() => {}}
            onOpenUrl={() => {
              handleOpenBookmark(bookmark);
            }}
            onPin={(pinned) => {
              void handlePin(bookmark.id, pinned);
            }}
            onEdit={handleEdit}
            onDelete={(item) => {
              setDeleteTarget(item);
            }}
            currentUserId={currentUserId}
          />
        ))}
      </div>
      {deleteDialog}
    </>
  );
}
