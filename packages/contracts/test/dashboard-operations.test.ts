import { describe, expect, it } from "vitest";
import { DashboardSchema, getDashboard, operations } from "../src/index.ts";

// The dashboard of doc 04 section 10.8 and doc 02 section 9.3: GET /api/v1/dashboard is a member's read in the active workspace and is the session's alone, so it declares no token scope.

const UUID = "0192f3a0-aaaa-7000-8000-00000000a0b1";
const BOOKMARK = { id: UUID, title: "Mail", url: "https://mail.example.com/", host: "mail.example.com", slug: "mail", forwarding: true, openCount: 3 };
const DASHBOARD = {
  counts: { bookmarks: 4, folders: 2, tags: 3, sharedWithYou: null },
  quickAccess: [BOOKMARK],
  pinned: [{ ...BOOKMARK, slug: null, forwarding: false }],
  topTags: [{ id: UUID, name: "read", bookmarkCount: 2 }],
  sharing: null,
  onboarding: { bookmarkAdded: true, slugGiven: true, browserSetupDone: false, folderCreated: true, importDone: false, dismissed: false },
};

describe("the dashboard operation", () => {
  it("is GET /api/v1/dashboard, a member's read in the read rate bucket that no API token may call", () => {
    expect(getDashboard).toMatchObject({ method: "get", path: "/api/v1/dashboard", operationId: "getDashboard", tag: "dashboard", auth: "member", rate: "read" });
    expect(getDashboard).not.toHaveProperty("scope");
    expect(getDashboard).not.toHaveProperty("request");
    expect(operations).toEqual(expect.arrayContaining([getDashboard]));
  });

  it("declares the answers a client has to handle", () => {
    expect(Object.keys(getDashboard.responses).map(Number)).toEqual(expect.arrayContaining([200, 401, 403, 404, 429, 503]));
  });
});

describe("the dashboard", () => {
  it("is the counts, the quick access, the pinned bookmarks, the top tags, the sharing block and the checklist", () => {
    expect(DashboardSchema.parse(DASHBOARD)).toEqual(DASHBOARD);
    expect(Object.keys(DashboardSchema.shape).sort()).toEqual(["counts", "onboarding", "pinned", "quickAccess", "sharing", "topTags"]);
  });

  it("carries the shared count and the sharing block as null, which is all there is until sharing exists", () => {
    expect(DashboardSchema.safeParse({ ...DASHBOARD, counts: { ...DASHBOARD.counts, sharedWithYou: 2 } }).success).toBe(true);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, sharing: { sharedWithYou: 2, sharedByYou: 1 } }).success).toBe(true);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, sharing: undefined }).success).toBe(false);
  });

  it("holds at most 8 quick-access bookmarks, 12 pinned ones and 12 tags", () => {
    expect(DashboardSchema.safeParse({ ...DASHBOARD, quickAccess: Array.from({ length: 8 }, () => BOOKMARK) }).success).toBe(true);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, quickAccess: Array.from({ length: 9 }, () => BOOKMARK) }).success).toBe(false);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, pinned: Array.from({ length: 12 }, () => BOOKMARK) }).success).toBe(true);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, pinned: Array.from({ length: 13 }, () => BOOKMARK) }).success).toBe(false);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, topTags: Array.from({ length: 12 }, () => DASHBOARD.topTags[0]) }).success).toBe(true);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, topTags: Array.from({ length: 13 }, () => DASHBOARD.topTags[0]) }).success).toBe(false);
  });

  it("names the five checklist items and whether the checklist is dismissed, and nothing else", () => {
    const { onboarding } = DASHBOARD;
    expect(DashboardSchema.safeParse({ ...DASHBOARD, onboarding: { ...onboarding, extra: true } }).success).toBe(false);
    for (const key of Object.keys(onboarding)) {
      const rest = Object.fromEntries(Object.entries(onboarding).filter(([name]) => name !== key));
      expect(DashboardSchema.safeParse({ ...DASHBOARD, onboarding: rest }).success, key).toBe(false);
    }
  });

  it("has no recent block and never names an owner or a version of a bookmark", () => {
    expect(DashboardSchema.safeParse({ ...DASHBOARD, recent: [] }).success).toBe(false);
    expect(DashboardSchema.safeParse({ ...DASHBOARD, quickAccess: [{ ...BOOKMARK, ownerId: UUID }] }).success).toBe(false);
  });
});
