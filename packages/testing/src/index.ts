export * from "@slugbase/testing-ports";
export { LimitedEntitlementSource } from "./entitlements.js";
export type { GrantedValue } from "./entitlements.js";
// The factories of the development seed (doc 08 section 1.4), which the browser journeys reuse. The rest of the seed, the
// script and its guard, is the package's own tooling and is not exported.
export { BOOKMARK_SHAPE_NAMES, bookmarkShapes, buildBookmarks } from "./seed/bookmarks.js";
export type { BookmarkContext, BookmarkShapeName, SeedBookmark } from "./seed/bookmarks.js";
export { DEMO_BOOKMARK_COUNT, DEMO_NOW, DEMO_SEED, LARGE_BOOKMARK_COUNT, buildDemoInstance } from "./seed/instance.js";
export type { DemoInstance, DemoInstanceOptions, SeedAccount, SeedAccountKey, SeedBookmarkShare, SeedFolder, SeedWorkspace } from "./seed/instance.js";
export { createIds, createRandom } from "./seed/random.js";
export type { Random } from "./seed/random.js";
