import { describe, expect, it } from "vitest";

import type { AccessibleForwardingMatch, SlugPreferenceRecord } from "./slug.types.js";
import { enrichSlugPreference, isSlugAmbiguous } from "./go.service.js";

function makeMatch(
  overrides: Partial<AccessibleForwardingMatch> & Pick<AccessibleForwardingMatch, "id">,
): AccessibleForwardingMatch {
  return {
    id: overrides.id,
    workspaceId: "ws-1",
    userId: overrides.userId ?? "owner-1",
    title: overrides.title ?? "Example",
    url: overrides.url ?? "https://example.com",
    slug: overrides.slug ?? "demo",
    forwardingEnabled: true,
    pinned: false,
    planArchived: false,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    folders: [],
    tags: [],
  };
}

function makePreference(
  overrides: Partial<SlugPreferenceRecord> = {},
): SlugPreferenceRecord {
  return {
    id: "pref-1",
    workspaceId: "ws-1",
    userId: "user-1",
    slug: "demo",
    bookmarkId: "bm-1",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("isSlugAmbiguous", () => {
  it("returns false for zero or one match", () => {
    expect(isSlugAmbiguous(0)).toBe(false);
    expect(isSlugAmbiguous(1)).toBe(false);
  });

  it("returns true when two or more matches exist", () => {
    expect(isSlugAmbiguous(2)).toBe(true);
    expect(isSlugAmbiguous(5)).toBe(true);
  });
});

describe("enrichSlugPreference", () => {
  it("maps bookmark fields and ambiguity from accessible matches", () => {
    const preference = makePreference();
    const matches = [
      makeMatch({
        id: "bm-1",
        title: "Primary",
        url: "https://primary.example.com",
        userId: "owner-a",
      }),
      makeMatch({
        id: "bm-2",
        title: "Secondary",
        url: "https://secondary.example.com",
        userId: "owner-b",
      }),
    ];

    expect(enrichSlugPreference(preference, matches)).toEqual({
      ...preference,
      bookmarkTitle: "Primary",
      bookmarkUrl: "https://primary.example.com",
      ownerUserId: "owner-a",
      isAmbiguous: true,
    });
  });

  it("returns null when the preferred bookmark is no longer accessible", () => {
    const preference = makePreference({ bookmarkId: "missing" });
    const matches = [makeMatch({ id: "bm-2" })];

    expect(enrichSlugPreference(preference, matches)).toBeNull();
  });
});
