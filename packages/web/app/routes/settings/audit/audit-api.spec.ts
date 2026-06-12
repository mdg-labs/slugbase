import { describe, expect, it } from "vitest";

import { deriveAuditActors, normalizeAuditEventsPage } from "./audit-api.js";

describe("deriveAuditActors", () => {
  it("returns an empty array when there are no items", () => {
    expect(deriveAuditActors([])).toEqual([]);
  });

  it("returns an empty array when items lack actor identifiers", () => {
    expect(deriveAuditActors([{ actorName: "Ghost" }])).toEqual([]);
  });

  it("deduplicates actors and sorts by display name", () => {
    const actors = deriveAuditActors([
      { actorUserId: "user-b", actorName: "Zoe Admin" },
      { actorUserId: "user-a", actorName: "Alex Owner" },
      { actorId: "user-a", actorName: "Alex Owner" },
      { actorUserId: "user-c", actorName: null },
    ]);

    expect(actors).toEqual([
      { id: "user-a", name: "Alex Owner" },
      { id: "user-c", name: "Unknown" },
      { id: "user-b", name: "Zoe Admin" },
    ]);
  });

  it("prefers a known name over Unknown for the same actor id", () => {
    const actors = deriveAuditActors([
      { actorUserId: "user-a", actorName: null },
      { actorUserId: "user-a", actorName: "Alex Owner" },
    ]);

    expect(actors).toEqual([{ id: "user-a", name: "Alex Owner" }]);
  });
});

describe("normalizeAuditEventsPage", () => {
  it("derives actors when the API omits the actors field", () => {
    const page = normalizeAuditEventsPage({
      items: [
        { actorUserId: "user-a", actorName: "Alex Owner" },
        { actorUserId: "user-b", actorName: "Zoe Admin" },
      ],
      total: 2,
      page: 0,
      pageSize: 8,
    });

    expect(page.actors).toEqual([
      { id: "user-a", name: "Alex Owner" },
      { id: "user-b", name: "Zoe Admin" },
    ]);
  });

  it("preserves API-provided actors when present", () => {
    const provided = [{ id: "user-a", name: "Alex Owner" }];
    const page = normalizeAuditEventsPage({
      items: [{ actorUserId: "user-b", actorName: "Zoe Admin" }],
      total: 1,
      page: 0,
      pageSize: 8,
      actors: provided,
    });

    expect(page.actors).toBe(provided);
  });
});
