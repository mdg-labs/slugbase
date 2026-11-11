import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineJob } from "../../src/worker/index.ts";
import { moduleContext } from "../support.ts";

describe("defineJob undeclaredKeys", () => {
  const seen: unknown[] = [];
  const handle = (payload: unknown) => {
    seen.push(payload);
    return Promise.resolve();
  };

  it("drops a payload key the job does not declare when the job ignores them, and still validates the declared fields", async () => {
    const job = defineJob({ name: "event.test", payload: z.object({ id: z.string() }), undeclaredKeys: "ignore", handle });
    expect(job.parse({ id: "x", later: "a field" })).toEqual({ id: "x" });
    await job.handle({ id: "x", later: "a field" }, moduleContext());
    expect(seen).toEqual([{ id: "x" }]);
    await expect(job.handle({ id: 1, later: "a field" }, moduleContext())).rejects.toThrow();
    await expect(job.handle({ later: "a field" }, moduleContext())).rejects.toThrow();
  });

  it("refuses an undeclared key by default and when asked to", async () => {
    for (const options of [{}, { undeclaredKeys: "refuse" as const }]) {
      const job = defineJob({ name: "mail.send", payload: z.object({ id: z.string() }), handle, ...options });
      expect(() => job.parse({ id: "x", later: "a field" })).toThrow();
      await expect(job.handle({ id: "x", later: "a field" }, moduleContext())).rejects.toThrow();
    }
  });
});
