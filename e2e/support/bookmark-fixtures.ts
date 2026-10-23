import { BOOKMARK_SHAPE_NAMES, buildDemoInstance, type BookmarkShapeName, type SeedBookmark } from "@slugbase/testing";

// The bookmarks the journeys use are the ones `pnpm db:seed` writes (doc 08 section 1.4): the same factories of
// @slugbase/testing, so a shape that breaks a list in development breaks the same list in a journey.

export { BOOKMARK_SHAPE_NAMES };
export type { BookmarkShapeName };

/** What `POST /api/v1/bookmarks` takes (CreateBookmarkRequest): the fields a member gives, none of the stored ones. */
export interface BookmarkBody {
  url: string;
  title: string;
  description?: string;
  pinned?: boolean;
}

const demo = buildDemoInstance({ largeBookmarks: 0 }).workspaces[0];
if (demo === undefined) {
  throw new Error("the demo instance has a demo workspace");
}

/** The bookmarks of the demo workspace of the seed: the named shapes first, then filler. */
export const demoBookmarks: readonly SeedBookmark[] = demo.bookmarks;

/** The bookmark of one named shape (a very long title, a right-to-left one, markup-like text, a duplicate URL, ...). */
export function bookmarkShape(name: BookmarkShapeName): SeedBookmark {
  const bookmark = demoBookmarks[BOOKMARK_SHAPE_NAMES.indexOf(name)];
  if (bookmark === undefined) {
    throw new Error(`the demo workspace has no bookmark of the shape ${name}`);
  }
  return bookmark;
}

/** The request body that creates a bookmark like `bookmark`. */
export function bookmarkBody(bookmark: SeedBookmark): BookmarkBody {
  return {
    url: bookmark.url,
    title: bookmark.title,
    ...(bookmark.description === null ? {} : { description: bookmark.description }),
    ...(bookmark.pinnedAt === null ? {} : { pinned: true }),
  };
}
