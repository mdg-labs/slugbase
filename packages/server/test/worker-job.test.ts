import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_RETRY_POLICY,
  JobDefinitionError,
  NotIdempotentError,
  assertIdempotent,
  defineJob,
  defineSchedule,
} from "../src/worker/index.ts";
import { queueSettings, queueUpdates } from "../src/worker/queues.ts";
import { moduleContext } from "./support.ts";

const handle = () => Promise.resolve();

const context = moduleContext;

describe("defineJob", () => {
  it("accepts a payload of scalar identifiers and validates what it receives", () => {
    const job = defineJob({
      name: "bookmark.fetchMetadata",
      payload: z.object({ workspaceId: z.uuid(), bookmarkId: z.uuid(), force: z.boolean().optional(), kind: z.enum(["a", "b"]) }),
      handle,
    });
    const id = "0190a000-0000-7000-8000-000000000001";
    expect(job.parse({ workspaceId: id, bookmarkId: id, kind: "a" })).toEqual({ workspaceId: id, bookmarkId: id, kind: "a" });
    expect(() => job.parse({ workspaceId: "nope", bookmarkId: id, kind: "a" })).toThrow();
    expect(job.retry).toEqual(DEFAULT_RETRY_POLICY);
  });

  it("refuses a payload that is not strictly the declared fields", async () => {
    const job = defineJob({ name: "mail.send", payload: z.object({ id: z.string() }), handle });
    expect(() => job.parse({ id: "x", body: "a whole document" })).toThrow();
    await expect(job.handle({ id: "x", body: "a whole document" }, context())).rejects.toThrow();
  });

  it.each([
    ["an object", z.object({ nested: z.object({ a: z.string() }) })],
    ["an array", z.object({ list: z.array(z.string()) })],
    ["a record", z.object({ bag: z.record(z.string(), z.string()) })],
    ["an optional object", z.object({ nested: z.object({}).optional() })],
  ] as [string, z.ZodObject<z.ZodRawShape>][])("refuses a payload field that is %s", (_label, payload) => {
    expect(() => defineJob({ name: "mail.send", payload, handle })).toThrow(JobDefinitionError);
  });

  it.each(["send", "Mail.send", "mail.", "mail send", "mail.Send"])("refuses the job name %s", (name) => {
    expect(() => defineJob({ name, payload: z.object({}), handle })).toThrow(JobDefinitionError);
  });

  it.each([
    [{ limit: -1 }],
    [{ limit: 1.5 }],
    [{ delaySeconds: -1 }],
    [{ backoff: false, maxDelaySeconds: 60 }],
    [{ delaySeconds: 30, backoff: true, maxDelaySeconds: 10 }],
  ])("refuses the retry policy %j", (retry) => {
    expect(() => defineJob({ name: "mail.send", payload: z.object({}), handle, retry })).toThrow(JobDefinitionError);
  });

  it("passes the context to the handler", async () => {
    const seen: unknown[] = [];
    const job = defineJob({
      name: "mail.send",
      payload: z.object({ id: z.string() }),
      handle: (payload, given) => {
        seen.push(payload, given);
        return Promise.resolve();
      },
    });
    const given = context();
    await job.handle({ id: "m1" }, given);
    expect(seen).toEqual([{ id: "m1" }, given]);
  });
});

describe("the queue of a job that keeps one waiting job for each key", () => {
  const plain = defineJob({ name: "test.plain", payload: z.object({}), handle });
  const deduped = defineJob({ name: "test.deduped", payload: z.object({}), handle, dedupe: true, retry: { limit: 1, delaySeconds: 5, backoff: false } });

  it("is created with the short policy of pg-boss, and a job that does not ask for it with none", () => {
    expect(plain.dedupe).toBe(false);
    expect(queueSettings(plain)).not.toHaveProperty("policy");
    expect(deduped.dedupe).toBe(true);
    expect(queueSettings(deduped)).toMatchObject({ policy: "short", retryLimit: 1, retryDelay: 5, retryBackoff: false });
  });

  it("is updated without its policy, which pg-boss refuses to change, and with the rest of its settings", () => {
    expect(queueUpdates(deduped)).not.toHaveProperty("policy");
    expect(queueUpdates(deduped)).toMatchObject({ retryLimit: 1, retryDelay: 5, retryBackoff: false });
    expect(queueUpdates(plain)).toEqual(queueSettings(plain));
  });
});

describe("defineSchedule", () => {
  it("accepts five or six cron fields and refuses any other count", () => {
    expect(defineSchedule({ name: "retention.hourly", cron: "0 * * * *", job: "retention.purge" }).cron).toBe("0 * * * *");
    expect(defineSchedule({ name: "x", cron: "0 0 * * * *", job: "retention.purge" }).cron).toBe("0 0 * * * *");
    expect(() => defineSchedule({ name: "x", cron: "* * *", job: "retention.purge" })).toThrow(JobDefinitionError);
  });
});

describe("assertIdempotent", () => {
  it("passes a job whose second run leaves the state of the first", async () => {
    const rows = new Set<string>();
    const job = defineJob({
      name: "test.safe",
      payload: z.object({ id: z.string() }),
      handle: (payload) => {
        rows.add(payload.id);
        return Promise.resolve();
      },
    });
    await assertIdempotent({ job, payload: { id: "a" }, context: context(), state: () => Promise.resolve([...rows]) });
  });

  it("fails a job that changes state again when it runs again", async () => {
    let count = 0;
    const job = defineJob({
      name: "test.counting",
      payload: z.object({ id: z.string() }),
      handle: () => {
        count += 1;
        return Promise.resolve();
      },
    });
    await expect(
      assertIdempotent({ job, payload: { id: "a" }, context: context(), state: () => Promise.resolve(count) }),
    ).rejects.toBeInstanceOf(NotIdempotentError);
  });

  it("fails a job whose second run throws", async () => {
    let first = true;
    const job = defineJob({
      name: "test.throwing",
      payload: z.object({ id: z.string() }),
      handle: () => {
        if (!first) {
          return Promise.reject(new Error("second run"));
        }
        first = false;
        return Promise.resolve();
      },
    });
    await expect(
      assertIdempotent({ job, payload: { id: "a" }, context: context(), state: () => Promise.resolve(null) }),
    ).rejects.toThrow("second run");
  });
});
