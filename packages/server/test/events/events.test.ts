import type { AnyDomainEvent } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { CompositionError, createServer, type ServerModule } from "../../src/create-server.ts";
import { EventDeliveryError, eventJobName, eventJobs, queueDomainEvent, subscribersOf, type RegisteredSubscriber } from "../../src/events/index.ts";
import { builtInJobs } from "../../src/worker/built-in.ts";
import { adapters, fakeDatabase, moduleContext, recordingLogger, serverConfig } from "../support.ts";

const EVENT_ID = "0192f3a0-aaaa-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const EMAIL = "private@example.test";

function composeFailure(subscribers: unknown): CompositionError {
  const module = { name: "bad", register: () => ({ subscribers }) } as unknown as ServerModule;
  const database = fakeDatabase();
  try {
    createServer({ config: serverConfig(), adapters: adapters(), modules: [module], migrations: [], logger: recordingLogger(), database });
  } catch (error) {
    if (error instanceof CompositionError) {
      expect(database.closed.count).toBe(1);
      return error;
    }
    throw error;
  }
  throw new Error("expected a CompositionError");
}

describe("the subscribers of a module", () => {
  it("compose when they name an event of the catalog and have a handler", () => {
    const module: ServerModule = {
      name: "listener",
      register: () => ({ subscribers: [{ event: "account.created", handle: () => undefined }] }),
    };
    expect(() =>
      createServer({ config: serverConfig(), adapters: adapters(), modules: [module], migrations: [], logger: recordingLogger(), database: fakeDatabase() }),
    ).not.toThrow();
  });

  it("fail composition when one names an event that is not in the catalog", () => {
    const error = composeFailure([{ event: "account.vanished", handle: () => undefined }]);
    expect(error.code).toBe("invalid_subscriber");
    expect(error.message).toContain("bad");
    expect(error.message).toContain("account.vanished");
  });

  it("fail composition when a handler is not a function, or the binding or the list is malformed", () => {
    for (const subscribers of [[{ event: "account.created", handle: "yes" }], [{ event: "account.created" }], [null], ["account.created"], "account.created", {}]) {
      expect(composeFailure(subscribers).code).toBe("invalid_subscriber");
    }
  });
});

describe("queueDomainEvent", () => {
  it("carries the acknowledgements as JSON text, since a job's payload holds scalar fields only", () => {
    const acknowledgements = [{ id: "terms", version: "2026-01" }];
    expect(queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "self-registration", acknowledgements }).data).toEqual({
      eventId: EVENT_ID,
      accountId: ACCOUNT,
      path: "self-registration",
      acknowledgements: JSON.stringify(acknowledgements),
    });
  });

  it("refuses an acknowledgements list that breaks a bound", () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ id: `doc-${String(index)}`, version: "1" }));
    for (const acknowledgements of [nine, [{ id: "Terms", version: "1" }], [{ id: "terms", version: "" }]]) {
      expect(() => queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "self-registration", acknowledgements })).toThrow();
    }
  });

  it("builds the job of an event, named for it, carrying the identifier and the payload", () => {
    expect(queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "setup", acknowledgements: [] })).toEqual({
      id: EVENT_ID,
      queue: "event.account.created",
      data: { eventId: EVENT_ID, accountId: ACCOUNT, path: "setup", acknowledgements: "[]" },
    });
    expect(eventJobName("account.created")).toBe("event.account.created");
  });

  it("refuses a payload the catalog does not declare, such as one with an email address", () => {
    expect(() => queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "setup", acknowledgements: [], email: EMAIL } as never)).toThrow();
    expect(() => queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "register", acknowledgements: [] } as never)).toThrow();
  });
});

describe("the event jobs", () => {
  const data = { eventId: EVENT_ID, accountId: ACCOUNT, path: "invitation", acknowledgements: "[]" };

  function registered(module: string, handle: (event: AnyDomainEvent) => void | Promise<void>): RegisteredSubscriber {
    return { module, event: "account.created", handle };
  }

  function jobFor(subscribers: readonly RegisteredSubscriber[]) {
    const job = eventJobs((name) => subscribersOf(subscribers, name)).find((candidate) => candidate.name === "event.account.created");
    if (job === undefined) {
      throw new Error("no event.account.created job");
    }
    return job;
  }

  it("exist for every event of the catalog, among the built-in jobs", () => {
    expect(builtInJobs().map((job) => job.name)).toContain("event.account.created");
  });

  it("hand the event to every subscriber of that event, in registration order", async () => {
    const seen: string[] = [];
    const job = jobFor([
      registered("a", (event) => {
        seen.push(`a:${event.eventId}:${event.name}:${JSON.stringify(event.payload)}`);
      }),
      registered("b", async (event) => {
        await Promise.resolve();
        seen.push(`b:${event.eventId}`);
      }),
    ]);

    await job.handle(data, moduleContext());

    expect(seen).toEqual([`a:${EVENT_ID}:account.created:${JSON.stringify({ accountId: ACCOUNT, path: "invitation", acknowledgements: [] })}`, `b:${EVENT_ID}`]);
  });

  it("deliver an event queued before the field existed with an empty list", async () => {
    const seen: unknown[] = [];
    const job = jobFor([registered("a", (event) => void seen.push(event.payload))]);

    await job.handle({ eventId: EVENT_ID, accountId: ACCOUNT, path: "invitation" }, moduleContext());

    expect(seen).toEqual([{ accountId: ACCOUNT, path: "invitation", acknowledgements: [] }]);
  });

  it("deliver the acknowledgements a job carries, and refuse a list that breaks a bound", async () => {
    const seen: unknown[] = [];
    const job = jobFor([registered("a", (event) => void seen.push(event.payload))]);
    const acknowledgements = [{ id: "terms", version: "2026-01" }];

    await job.handle({ ...data, acknowledgements: JSON.stringify(acknowledgements) }, moduleContext());

    expect(seen).toEqual([{ accountId: ACCOUNT, path: "invitation", acknowledgements }]);
    const nine = Array.from({ length: 9 }, (_, index) => ({ id: `doc-${String(index)}`, version: "1" }));
    for (const bad of [nine, [{ id: "Terms", version: "1" }], [{ id: "terms", version: "" }], [{ id: "terms", version: "1" }, { id: "terms", version: "2" }], "terms"]) {
      await expect(job.handle({ ...data, acknowledgements: JSON.stringify(bad) }, moduleContext())).rejects.toThrow();
    }
    for (const text of ["not json", "{", "x".repeat(3000)]) {
      await expect(job.handle({ ...data, acknowledgements: text }, moduleContext())).rejects.toThrow();
    }
    await expect(job.handle({ ...data, acknowledgements: [] }, moduleContext())).rejects.toThrow();
  });

  it("do nothing when no module subscribes", async () => {
    await expect(jobFor([]).handle(data, moduleContext())).resolves.toBeUndefined();
  });

  it("refuse a payload that is not the catalog's", async () => {
    const job = jobFor([registered("a", () => undefined)]);
    await expect(job.handle({ ...data, email: EMAIL }, moduleContext())).rejects.toThrow();
    await expect(job.handle({ eventId: EVENT_ID, accountId: ACCOUNT, path: "register" }, moduleContext())).rejects.toThrow();
    await expect(job.handle({ accountId: ACCOUNT, path: "setup" }, moduleContext())).rejects.toThrow();
  });

  it("run every subscriber, then fail so the job retries, logging the module and the event but never the payload", async () => {
    const delivered: string[] = [];
    const context = moduleContext();
    const job = jobFor([
      registered("broken", () => {
        throw new Error(`could not record ${EMAIL} for ${ACCOUNT}`);
      }),
      registered("fine", (event) => {
        delivered.push(event.eventId);
      }),
    ]);

    const failure = await job.handle(data, context).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EventDeliveryError);
    expect(delivered).toEqual([EVENT_ID]);
    const logger = context.logger as ReturnType<typeof recordingLogger>;
    expect(logger.entries).toEqual([
      { level: "error", message: "An event subscriber failed", fields: { event: "account.created", eventId: EVENT_ID, module: "broken", error: "Error" } },
    ]);
    const everything = JSON.stringify([logger.entries, String(failure)]);
    expect(everything).not.toContain(EMAIL);
    expect(everything).not.toContain(ACCOUNT);
    expect(everything).not.toContain("invitation");
  });
});
