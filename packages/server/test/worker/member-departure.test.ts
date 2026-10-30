import type { DomainEvent } from "@slugbase/core";
import type { TenantContext } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { createBuiltInModules } from "../../src/worker/built-in.ts";
import { applyDeparture } from "../../src/worker/member-departure.ts";
import { adapters, recordingLogger, serverConfig } from "../support.ts";

const WORKSPACE = "0192f3a0-0000-7000-8000-000000000001";
const MEMBER = "0192f3a0-0000-7000-8000-000000000002";
const RECIPIENT = "0192f3a0-0000-7000-8000-000000000003";
const EVENT_ID = "0192f3a0-0000-7000-8000-000000000004";

const event: DomainEvent<"member.left"> = {
  eventId: EVENT_ID,
  name: "member.left",
  payload: { workspaceId: WORKSPACE, accountId: MEMBER, content: "delete", transferTo: RECIPIENT },
};

describe("the member.left subscriber", () => {
  it("is registered by the built-in modules for member.left and nothing else", () => {
    const modules = createBuiltInModules(
      {
        rateLimit: { purgeIdle: () => Promise.resolve(0) },
        retention: { purge: () => Promise.resolve([]) },
        workspaceDeletion: { purgeRows: () => Promise.resolve({}), finish: () => Promise.resolve(false) },
      },
      () => [],
    );
    const context = { config: serverConfig(), adapters: adapters(), withTenant: () => Promise.reject(new Error("not used")), logger: recordingLogger() };

    const subscribed = modules.flatMap((module) => module.register(context).subscribers ?? []);

    expect(subscribed.map((subscriber) => subscriber.event)).toEqual(["member.left"]);
  });

  it("opens its transaction in the departed member's workspace for the recipient, and rejects when the transaction does, so the event job retries", async () => {
    const opened: TenantContext[] = [];
    const handle = applyDeparture({
      withTenant: (tenant) => {
        opened.push(tenant);
        return Promise.reject(new Error("the database is down"));
      },
      logger: recordingLogger(),
    });

    await expect(handle(event)).rejects.toThrow("the database is down");

    expect(opened).toEqual([{ accountId: RECIPIENT, workspaceId: WORKSPACE, requestId: "event.member.left" }]);
  });
});
