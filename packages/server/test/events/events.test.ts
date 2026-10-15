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
  it("builds the job of an event, named for it, carrying the identifier and the payload", () => {
    expect(queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "setup" })).toEqual({
      id: EVENT_ID,
      queue: "event.account.created",
      data: { eventId: EVENT_ID, accountId: ACCOUNT, path: "setup" },
    });
    expect(eventJobName("account.created")).toBe("event.account.created");
  });

  it("refuses a payload the catalog does not declare, such as one with an email address", () => {
    expect(() => queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "setup", email: EMAIL } as never)).toThrow();
    expect(() => queueDomainEvent(EVENT_ID, "account.created", { accountId: ACCOUNT, path: "register" } as never)).toThrow();
  });
});

describe("the event jobs", () => {
  const data = { eventId: EVENT_ID, accountId: ACCOUNT, path: "invitation" };

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

    expect(seen).toEqual([`a:${EVENT_ID}:account.created:${JSON.stringify({ accountId: ACCOUNT, path: "invitation" })}`, `b:${EVENT_ID}`]);
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
