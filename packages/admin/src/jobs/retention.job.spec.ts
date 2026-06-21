import { describe, expect, it } from "vitest";

import { RetentionJob } from "./retention.job.js";

describe("RetentionJob", () => {
  it("computes a 400-day retention cutoff in UTC", () => {
    const job = new RetentionJob({} as never);
    const reference = new Date(Date.UTC(2026, 5, 21, 3, 0, 0));

    expect(job.retentionCutoffDate(reference)).toBe("2025-05-17");
  });
});
