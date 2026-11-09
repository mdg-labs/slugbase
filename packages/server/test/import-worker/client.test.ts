import { afterEach, describe, expect, it } from "vitest";
import { ImportWorker, ImportWorkerBusy, ImportWorkerError } from "../../src/import-worker/client.ts";
import type { ImportJob } from "../../src/import-worker/job.ts";

// The import worker thread as the request thread uses it (doc 01 section 8.1): one thread, started on first use and reused, imports queued for it, and a thread that fails fails that one job and is replaced. The stand-in
// thread (`stub-worker.mjs`) fails in the way its job's content type names, so each way a thread can fail is made on purpose; every worker a test makes is ended by it.

const STUB = new URL("./stub-worker.mjs", import.meta.url);
const made: ImportWorker[] = [];

function worker(options: { maxQueued?: number; timeoutMs?: number; entry?: URL } = {}): ImportWorker {
  const created = new ImportWorker({ entry: STUB, ...options });
  made.push(created);
  return created;
}

const job = (contentType = "ok", size = 3): ImportJob => ({ kind: "json", bytes: new Uint8Array(size).fill(1), contentType, digest: false });

afterEach(() => {
  for (const created of made.splice(0)) {
    created.terminate();
  }
});

describe("ImportWorker", () => {
  it("does a job on a thread of its own and hands the bytes over instead of copying them", async () => {
    const bytes = new Uint8Array(1024).fill(7);

    const outcome = (await worker().run({ kind: "json", bytes, contentType: "ok", digest: false })) as { bytes: number; threadId: number };

    expect(outcome.bytes).toBe(1024);
    expect(outcome.threadId).toBeGreaterThan(0);
    expect(bytes.byteLength).toBe(0);
  });

  it("starts the thread once and reuses it for the jobs after the first", async () => {
    const reused = worker();

    const threads = [await reused.run(job()), await reused.run(job()), await reused.run(job())].map((outcome) => (outcome as { threadId: number }).threadId);

    expect(new Set(threads).size).toBe(1);
  });

  it("copies a view of part of a buffer rather than handing over the buffer it shares", async () => {
    const whole = new Uint8Array(100).fill(1);
    const view = whole.subarray(10, 20);

    const outcome = (await worker().run({ kind: "json", bytes: view, contentType: "ok", digest: false })) as { bytes: number };

    expect(outcome.bytes).toBe(10);
    expect(whole.byteLength).toBe(100);
  });

  it.each(["throw", "exit", "wrong-id"])("fails the job when the thread %s, ends that thread, and the next job runs on a new one", async (how) => {
    const replaced = worker();
    const first = (await replaced.run(job())) as { threadId: number };

    await expect(replaced.run(job(how))).rejects.toBeInstanceOf(ImportWorkerError);
    const next = (await replaced.run(job())) as { threadId: number };

    expect(next.threadId).not.toBe(first.threadId);
  });

  it("fails the job that the thread says it could not do, and the thread goes on with the next one", async () => {
    const same = worker();
    const first = (await same.run(job())) as { threadId: number };

    await expect(same.run(job("failure"))).rejects.toBeInstanceOf(ImportWorkerError);

    expect(await same.run(job())).toMatchObject({ threadId: first.threadId });
  });

  it("fails the job that a thread does not answer in time, ends the thread and goes on with the next job", async () => {
    // The time counts from the hand-over, and a new thread has to start before it answers: the bound is far above that on a loaded machine, and the job that hangs is the only one that waits for it.
    const slow = worker({ timeoutMs: 2000 });

    await expect(slow.run(job("hang"))).rejects.toThrow(/did not answer within 2000 ms/);

    expect(await slow.run(job())).toMatchObject({ bytes: 3 });
  });

  it("queues the imports for the one thread, in the order they came, and refuses one past the queue", async () => {
    const busy = worker({ maxQueued: 2 });
    const order: number[] = [];
    const running = busy.run(job("hang"));
    const second = busy.run(job("ok", 2)).then((outcome) => order.push((outcome as { bytes: number }).bytes));
    const third = busy.run(job("ok", 3)).then((outcome) => order.push((outcome as { bytes: number }).bytes));

    await expect(busy.run(job())).rejects.toBeInstanceOf(ImportWorkerBusy);
    busy.terminate();
    await expect(running).rejects.toBeInstanceOf(ImportWorkerError);
    await expect(second).rejects.toBeInstanceOf(ImportWorkerError);
    await expect(third).rejects.toBeInstanceOf(ImportWorkerError);

    expect(order).toEqual([]);
    expect(await busy.run(job("ok", 5))).toMatchObject({ bytes: 5 });
  });

  it("runs the queued jobs one after the other", async () => {
    const queued = worker();
    const order: number[] = [];

    await Promise.all([1, 2, 3, 4].map((size) => queued.run(job("ok", size)).then((outcome) => order.push((outcome as { bytes: number }).bytes))));

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("fails every import, loudly, when the worker module is missing, and never does the work itself", async () => {
    const missing = worker({ entry: new URL("./no-such-worker.mjs", import.meta.url) });

    await expect(missing.run(job())).rejects.toThrow(/import worker module is missing/);
    await expect(missing.run(job())).rejects.toBeInstanceOf(ImportWorkerError);
  });
});
