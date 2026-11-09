import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ImportJob } from "./job.ts";

// The import worker thread as the request thread uses it (doc 01 section 8.1): one thread, started when the first import needs it and reused after that, that does the CPU work of an import (`job.ts`) while the request
// thread serves everything else. Imports queue for it, one job at a time in the order they came, and at most `MAX_QUEUED` wait: a further one is refused at once as `ImportWorkerBusy` (the route answers `503`), so a
// burst of imports holds at most that many bodies in memory. A job that takes longer than `JOB_TIMEOUT_MS`, a thread that dies, throws or answers with something that is not an answer to the job it was given fails that one
// job (`ImportWorkerError`, a `500`), the thread is ended, and the next job starts a new one. Nothing falls back to doing the work on the request thread: a worker file that is not there fails every import, loudly.
// The thread never keeps the process alive.

/** How many imports may wait for the thread while one runs. */
export const MAX_QUEUED = 8;

/** The longest one job may take: a file of the largest size is read in well under a second, so a job that is still running is stuck. */
export const JOB_TIMEOUT_MS = 60_000;

/** The most memory the thread's heap may use; a file that needs more ends the thread, not the process. */
const MAX_HEAP_MB = 512;

/** A job failed: the thread died, threw, timed out, was ended or answered wrongly. The import fails, and the next one gets a working thread. */
export class ImportWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImportWorkerError";
  }
}

/** The thread has `MAX_QUEUED` jobs waiting already. */
export class ImportWorkerBusy extends Error {
  constructor() {
    super("the import worker has too many imports waiting");
    this.name = "ImportWorkerBusy";
  }
}

export interface ImportWorkerOptions {
  /** The module the thread runs. */
  readonly entry: URL;
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly id: number;
  readonly job: ImportJob;
  readonly resolve: (outcome: unknown) => void;
  readonly reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

/** The thread's buffer for `bytes` when it is the whole of it, so that it can be handed over rather than copied; a view of part of a buffer is copied first. */
function transferable(bytes: Uint8Array): { readonly bytes: Uint8Array; readonly buffer: ArrayBuffer } {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return { bytes, buffer: bytes.buffer };
  }
  const copy = new Uint8Array(bytes);
  return { bytes: copy, buffer: copy.buffer };
}

export class ImportWorker {
  readonly #entry: URL;
  readonly #maxQueued: number;
  readonly #timeoutMs: number;
  readonly #queue: Pending[] = [];
  #worker: Worker | undefined;
  #active: Pending | undefined;
  #nextId = 1;

  constructor(options: ImportWorkerOptions) {
    this.#entry = options.entry;
    this.#maxQueued = options.maxQueued ?? MAX_QUEUED;
    this.#timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  }

  /** Does `job` on the thread and answers what the thread answered, which the caller must check: it is data from another thread. The bytes of the job are handed to the thread, so they are empty here afterwards. */
  run(job: ImportJob): Promise<unknown> {
    if (this.#queue.length >= this.#maxQueued) {
      return Promise.reject(new ImportWorkerBusy());
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextId++, job, resolve, reject });
      this.#next();
    });
  }

  /** Ends the thread now. The job it is running and the jobs waiting fail, and the next job starts a new thread. */
  terminate(): void {
    const error = new ImportWorkerError("the import worker was ended");
    const waiting = this.#queue.splice(0);
    this.#fail(this.#worker, error);
    for (const pending of waiting) {
      pending.reject(error);
    }
  }

  #start(): Worker {
    if (this.#worker !== undefined) {
      return this.#worker;
    }
    if (!existsSync(this.#entry)) {
      throw new ImportWorkerError(`the import worker module is missing: ${fileURLToPath(this.#entry)}`);
    }
    const worker = new Worker(this.#entry, { name: "slugbase-import", resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB } });
    // A thread that is idle must not keep the process from ending.
    worker.unref();
    worker.on("message", (message: unknown) => {
      this.#answered(worker, message);
    });
    worker.on("error", (error: Error) => {
      this.#fail(worker, new ImportWorkerError("the import worker failed", { cause: error }));
    });
    worker.on("messageerror", (error: Error) => {
      this.#fail(worker, new ImportWorkerError("the import worker answered with something that cannot be read", { cause: error }));
    });
    worker.on("exit", (code) => {
      this.#fail(worker, new ImportWorkerError(`the import worker exited with code ${String(code)}`));
    });
    this.#worker = worker;
    return worker;
  }

  #next(): void {
    if (this.#active !== undefined) {
      return;
    }
    const pending = this.#queue.shift();
    if (pending === undefined) {
      return;
    }
    this.#active = pending;
    let worker: Worker;
    try {
      worker = this.#start();
    } catch (error) {
      this.#fail(undefined, error instanceof Error ? error : new ImportWorkerError("the import worker could not start", { cause: error }));
      return;
    }
    pending.timer = setTimeout(() => {
      this.#fail(worker, new ImportWorkerError(`the import worker did not answer within ${String(this.#timeoutMs)} ms`));
    }, this.#timeoutMs);
    try {
      const body = transferable(pending.job.bytes);
      worker.postMessage({ id: pending.id, job: { ...pending.job, bytes: body.bytes } }, [body.buffer]);
    } catch (error) {
      this.#fail(worker, new ImportWorkerError("the import worker could not be given the job", { cause: error }));
    }
  }

  #answered(worker: Worker, message: unknown): void {
    const pending = this.#active;
    if (worker !== this.#worker || pending === undefined) {
      return;
    }
    if (!isRecord(message) || message["id"] !== pending.id) {
      this.#fail(worker, new ImportWorkerError("the import worker answered a job it was not given"));
      return;
    }
    if (message["failure"] === true || !("outcome" in message)) {
      this.#settle(pending, undefined, new ImportWorkerError("the import worker could not do the job"));
      return;
    }
    this.#settle(pending, message["outcome"]);
  }

  /** Ends the thread `worker` (when it is the current one) and fails the job it was doing. */
  #fail(worker: Worker | undefined, error: Error): void {
    if (worker !== undefined) {
      if (worker !== this.#worker) {
        return;
      }
      this.#worker = undefined;
      worker.terminate().catch(() => undefined);
    }
    const pending = this.#active;
    if (pending !== undefined) {
      this.#settle(pending, undefined, error);
    }
  }

  #settle(pending: Pending, outcome: unknown, error?: Error): void {
    clearTimeout(pending.timer);
    this.#active = undefined;
    if (error === undefined) {
      pending.resolve(outcome);
    } else {
      pending.reject(error);
    }
    this.#next();
  }
}

let shared: ImportWorker | undefined;

/** The module the thread runs: `worker.ts` next to this module when this one is run from source, `worker.js` when it is the compiled one. */
function workerEntry(): URL {
  return new URL(`./worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
}

/** The one import worker of the process, made when the first import asks for it. */
export function importWorker(): ImportWorker {
  shared ??= new ImportWorker({ entry: workerEntry() });
  return shared;
}
