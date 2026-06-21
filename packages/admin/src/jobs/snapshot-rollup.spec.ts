import { describe, expect, it } from "vitest";

import {
  aggregateWorkspacesByPlan,
  classifyWorkspacePlanBucket,
  countActiveSubscriptions,
  formatUtcDate,
  priorUtcDate,
  utcDayRangeMs,
  workspaceHasActiveSubscription,
} from "./snapshot-rollup.js";

describe("snapshot rollup helpers", () => {
  it("formats UTC dates as YYYY-MM-DD", () => {
    expect(formatUtcDate(new Date(Date.UTC(2026, 5, 21, 15, 30, 0)))).toBe(
      "2026-06-21",
    );
  });

  it("returns the prior UTC calendar day", () => {
    expect(
      priorUtcDate(new Date(Date.UTC(2026, 5, 21, 2, 0, 0))),
    ).toBe("2026-06-20");
  });

  it("computes inclusive UTC day bounds", () => {
    expect(utcDayRangeMs("2026-06-20")).toEqual({
      startMs: Date.UTC(2026, 5, 20, 0, 0, 0, 0),
      endMs: Date.UTC(2026, 5, 20, 23, 59, 59, 999),
    });
  });

  it("classifies supporter workspaces as personal", () => {
    expect(classifyWorkspacePlanBucket("free", true)).toBe("personal");
    expect(classifyWorkspacePlanBucket("personal", false)).toBe("personal");
    expect(classifyWorkspacePlanBucket("team", false)).toBe("team");
    expect(classifyWorkspacePlanBucket("free", false)).toBe("free");
  });

  it("aggregates workspaces_by_plan buckets", () => {
    expect(
      aggregateWorkspacesByPlan([
        { plan: "free", permanentPersonal: false },
        { plan: "personal", permanentPersonal: false },
        { plan: "free", permanentPersonal: true },
        { plan: "team", permanentPersonal: false },
      ]),
    ).toEqual({
      free: 1,
      personal: 2,
      team: 1,
    });
  });

  it("counts active subscriptions per §7.1 / D19", () => {
    expect(workspaceHasActiveSubscription("active", false)).toBe(true);
    expect(workspaceHasActiveSubscription("trialing", false)).toBe(true);
    expect(workspaceHasActiveSubscription("past_due", false)).toBe(true);
    expect(workspaceHasActiveSubscription("canceled", false)).toBe(false);
    expect(workspaceHasActiveSubscription(null, true)).toBe(true);

    expect(
      countActiveSubscriptions([
        { billingStatus: "active", permanentPersonal: false },
        { billingStatus: "canceled", permanentPersonal: false },
        { billingStatus: null, permanentPersonal: true },
      ]),
    ).toBe(2);
  });
});
