import { describe, expect, it } from "vitest";
import {
  BOOKMARK_SLUG_MAX_LENGTH,
  BOOKMARK_SLUG_PATTERN,
  CreateBookmarkRequestSchema,
  SlugAvailabilityQuerySchema,
  SlugAvailabilitySchema,
  UpdateBookmarkRequestSchema,
  checkSlugAvailability,
} from "../src/index.ts";

// The slug and forwarding of a bookmark in the contract (doc 02 section 6.1, doc 04 section 10.6): the grammar, the two request bodies and the availability
// operation. The server trims and lower-cases a slug and judges it against the grammar, so the schemas take any string and the grammar is the pattern.

const BOOKMARK = { url: "https://example.com/", title: "Docs" };
const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";

describe("the slug grammar", () => {
  it("holds 1 to 64 lower-case letters, digits and hyphens, not starting with a hyphen", () => {
    expect(BOOKMARK_SLUG_MAX_LENGTH).toBe(64);
    for (const slug of ["a", "0", "mail", "0-ok", "a-b-c", "a".repeat(64), "9".repeat(64)]) {
      expect(BOOKMARK_SLUG_PATTERN.test(slug), slug).toBe(true);
    }
    for (const slug of ["", "-a", "A", "Mail", "a b", "a_b", "a.b", "a/b", "a".repeat(65), "ü", "a\n", "\na"]) {
      expect(BOOKMARK_SLUG_PATTERN.test(slug), JSON.stringify(slug)).toBe(false);
    }
  });
});

describe("the bookmark requests", () => {
  it("take an optional slug and forwarding on a creation", () => {
    expect(CreateBookmarkRequestSchema.safeParse({ ...BOOKMARK, slug: "Mail", forwarding: false }).success).toBe(true);
    expect(CreateBookmarkRequestSchema.safeParse(BOOKMARK).success).toBe(true);
    expect(CreateBookmarkRequestSchema.safeParse({ ...BOOKMARK, slug: null }).success).toBe(false);
    expect(CreateBookmarkRequestSchema.safeParse({ ...BOOKMARK, forwarding: "yes" }).success).toBe(false);
  });

  it("take a slug that may be null, to clear it, and forwarding on a change", () => {
    expect(UpdateBookmarkRequestSchema.safeParse({ slug: null, forwarding: false }).success).toBe(true);
    expect(UpdateBookmarkRequestSchema.safeParse({ slug: "mail" }).success).toBe(true);
    expect(UpdateBookmarkRequestSchema.safeParse({}).success).toBe(true);
    expect(UpdateBookmarkRequestSchema.safeParse({ slug: 3 }).success).toBe(false);
  });
});

describe("the availability operation", () => {
  it("is a read of a member at GET /api/v1/slugs/availability", () => {
    expect(checkSlugAvailability).toMatchObject({ method: "get", path: "/api/v1/slugs/availability", operationId: "checkSlugAvailability", auth: "member", scope: "read" });
  });

  it("takes a slug and an optional identifier of a bookmark, and nothing else", () => {
    expect(SlugAvailabilityQuerySchema.safeParse({ slug: "mail" }).success).toBe(true);
    expect(SlugAvailabilityQuerySchema.safeParse({ slug: "", bookmarkId: UUID }).success).toBe(true);
    expect(SlugAvailabilityQuerySchema.safeParse({}).success).toBe(false);
    expect(SlugAvailabilityQuerySchema.safeParse({ slug: "mail", bookmarkId: "nope" }).success).toBe(false);
    expect(SlugAvailabilityQuerySchema.safeParse({ slug: "mail", extra: "1" }).success).toBe(false);
  });

  it("answers one of three statuses and a count", () => {
    for (const status of ["available", "taken_by_me", "invalid"]) {
      expect(SlugAvailabilitySchema.safeParse({ status, othersUseCount: 0 }).success, status).toBe(true);
    }
    expect(SlugAvailabilitySchema.safeParse({ status: "reserved", othersUseCount: 0 }).success).toBe(false);
    expect(SlugAvailabilitySchema.safeParse({ status: "available", othersUseCount: -1 }).success).toBe(false);
    expect(SlugAvailabilitySchema.safeParse({ status: "available" }).success).toBe(false);
  });
});
