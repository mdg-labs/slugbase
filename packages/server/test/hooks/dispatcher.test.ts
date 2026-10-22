import type { ClientErrorReportPort, SeatEntitlements } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { ProblemError } from "../../src/http/problem.ts";
import {
  DELETION_REFUSAL_CODES,
  REGISTRATION_REFUSAL_CODE,
  HookResult,
  createHookDispatcher,
  invalidHookRefusals,
  type DeletionGuardInput,
  type HookRegistration,
  type ServerHooks,
} from "../../src/hooks/index.ts";
import { adapters, recordingLogger, unlimitedSeats } from "../support.ts";

const seat = { workspaceId: "w1", accountId: "a1", invitationId: "i1" } as const;
const workspaceDeletion: DeletionGuardInput = { kind: "workspace", workspaceId: "w1", accountId: "a1", requestedBy: "member" };
const registration = { email: "someone@example.com", path: "self-registration" } as const;

const module = (name: string, hooks: ServerHooks, refusals: HookRegistration["refusals"] = { deletionGuard: ["billing_active"] }): HookRegistration => ({
  module: name,
  hooks,
  refusals,
});
const hanging = (): Promise<never> => new Promise(() => undefined);

function dispatcher(registrations: readonly HookRegistration[], overrides: { port?: ClientErrorReportPort; seats?: SeatEntitlements; timeoutMs?: number } = {}) {
  const logger = recordingLogger();
  return {
    logger,
    hooks: createHookDispatcher({
      registrations,
      clientErrorReport: overrides.port ?? adapters().clientErrorReport,
      seats: overrides.seats ?? unlimitedSeats,
      logger,
      timeoutMs: overrides.timeoutMs ?? 25,
    }),
  };
}

async function failure(run: Promise<unknown>): Promise<ProblemError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return error as ProblemError;
}

describe("with no module registered", () => {
  const { hooks } = dispatcher([]);

  it("keeps the seat limit of the entitlement", async () => {
    await expect(hooks.seatLimit(seat, 5)).resolves.toBe(5);
    await expect(hooks.seatLimit(seat, null)).resolves.toBeNull();
  });

  it("allows a deletion and a registration", async () => {
    await expect(hooks.deletionGuard(workspaceDeletion)).resolves.toEqual({ outcome: "allow" });
    await expect(hooks.registrationPolicy(registration)).resolves.toEqual({ outcome: "allow" });
  });

  it("supplies no DSN", async () => {
    await expect(hooks.clientErrorReportDsn({ accountId: "a1", workspaceId: undefined })).resolves.toBeNull();
  });
});

describe("modules that register no hook of a kind", () => {
  it("count as no module for that kind", async () => {
    const { hooks } = dispatcher([module("other", { registrationPolicy: () => HookResult.allow() })]);
    await expect(hooks.seatLimit(seat, 3)).resolves.toBe(3);
  });
});

describe("the seat check", () => {
  it("takes the lowest limit across modules, in any order", async () => {
    const a = module("a", { seatCheck: () => ({ seatLimit: 10 }) });
    const b = module("b", { seatCheck: () => ({ seatLimit: 4 }) });
    await expect(dispatcher([a, b]).hooks.seatLimit(seat, null)).resolves.toBe(4);
    await expect(dispatcher([b, a]).hooks.seatLimit(seat, null)).resolves.toBe(4);
  });

  it("replaces the entitlement's limit and ignores a null limit next to a number", async () => {
    const unlimited = module("a", { seatCheck: () => ({ seatLimit: null }) });
    const limited = module("b", { seatCheck: () => Promise.resolve({ seatLimit: 7 }) });
    await expect(dispatcher([unlimited, limited]).hooks.seatLimit(seat, 2)).resolves.toBe(7);
    await expect(dispatcher([unlimited]).hooks.seatLimit(seat, 2)).resolves.toBeNull();
  });

  it("starts an acceptance's limit from the engine's seats.max for the workspace, the account and the request", async () => {
    const asked: unknown[][] = [];
    const request = {};
    const seats: SeatEntitlements = {
      limit: (accountId, workspaceId, given) => {
        asked.push([accountId, workspaceId, given]);
        return Promise.resolve(3);
      },
    };
    await expect(dispatcher([], { seats }).hooks.acceptanceSeatLimit(seat, request)).resolves.toBe(3);
    expect(asked).toEqual([["a1", "w1", request]]);
  });

  it("lets a hook's lower limit replace the engine's, and a hook's answer replace it when higher", async () => {
    const seats: SeatEntitlements = { limit: () => Promise.resolve(5) };
    const lower = module("lower", { seatCheck: () => ({ seatLimit: 2 }) });
    const higher = module("higher", { seatCheck: () => ({ seatLimit: 9 }) });
    await expect(dispatcher([lower], { seats }).hooks.acceptanceSeatLimit(seat, {})).resolves.toBe(2);
    await expect(dispatcher([higher, lower], { seats }).hooks.acceptanceSeatLimit(seat, {})).resolves.toBe(2);
    await expect(dispatcher([higher], { seats }).hooks.acceptanceSeatLimit(seat, {})).resolves.toBe(9);
  });

  it("rejects, and consults no hook, when the engine cannot read the limit", async () => {
    const consulted: string[] = [];
    const seats: SeatEntitlements = { limit: () => Promise.reject(new Error("the source is down")) };
    const hook = module("a", { seatCheck: () => { consulted.push("a"); return { seatLimit: 1 }; } });
    await expect(dispatcher([hook], { seats }).hooks.acceptanceSeatLimit(seat, {})).rejects.toThrow("the source is down");
    expect(consulted).toEqual([]);
  });

  it("runs the hooks in registration order", async () => {
    const order: string[] = [];
    const named = (name: string) =>
      module(name, {
        seatCheck: () => {
          order.push(name);
          return { seatLimit: 1 };
        },
      });
    await dispatcher([named("first"), named("second"), named("third")]).hooks.seatLimit(seat, null);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it.each([
    ["a negative limit", { seatLimit: -1 }],
    ["a fractional limit", { seatLimit: 1.5 }],
    ["NaN", { seatLimit: Number.NaN }],
    ["a string", { seatLimit: "3" }],
    ["no limit", {}],
    ["no answer", undefined],
  ])("fails closed on %s", async (_name, answer) => {
    const { hooks, logger } = dispatcher([module("bad", { seatCheck: () => answer as { seatLimit: number } })]);
    const error = await failure(hooks.seatLimit(seat, null));
    expect(error.code).toBe("unavailable");
    expect(logger.entries[0]?.fields).toMatchObject({ hook: "seatCheck", module: "bad", reason: "invalid_result" });
  });

  it("fails closed when a hook throws, naming the module and never the error text", async () => {
    const { hooks, logger } = dispatcher([
      module("ok", { seatCheck: () => ({ seatLimit: 3 }) }),
      module("throws", {
        seatCheck: () => {
          throw new Error("secret-detail");
        },
      }),
    ]);
    const error = await failure(hooks.seatLimit(seat, null));
    expect(error.code).toBe("unavailable");
    expect(JSON.stringify(logger.entries)).not.toContain("secret-detail");
    expect(logger.entries[0]?.fields).toMatchObject({ module: "throws", reason: "threw" });
  });

  it("fails closed when a hook rejects", async () => {
    const { hooks } = dispatcher([module("rejects", { seatCheck: () => Promise.reject(new Error("no")) })]);
    expect((await failure(hooks.seatLimit(seat, null))).code).toBe("unavailable");
  });

  it("fails closed when a hook does not answer in time, even next to a module that answers", async () => {
    const { hooks, logger } = dispatcher([
      module("fast", { seatCheck: () => ({ seatLimit: 3 }) }),
      module("hangs", { seatCheck: hanging }),
    ]);
    const error = await failure(hooks.seatLimit(seat, null));
    expect(error.code).toBe("unavailable");
    expect(logger.entries[0]?.fields).toMatchObject({ module: "hangs", reason: "timeout" });
  });

  it("is not rescued by a late answer after the timeout", async () => {
    const late = module("late", { seatCheck: () => new Promise((resolve) => setTimeout(() => { resolve({ seatLimit: 9 }); }, 60)) });
    const { hooks, logger } = dispatcher([late]);
    expect((await failure(hooks.seatLimit(seat, null))).code).toBe("unavailable");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(logger.entries).toHaveLength(1);
  });
});

describe("the deletion guard", () => {
  it("lists billing_active as its only code", () => {
    expect([...DELETION_REFUSAL_CODES]).toEqual(["billing_active"]);
  });

  it("answers the first refusal in registration order", async () => {
    const allow = module("allow", { deletionGuard: () => HookResult.allow() });
    const refuse = module("refuse", { deletionGuard: () => HookResult.refuse("billing_active") });
    const later = module("later", { deletionGuard: () => Promise.resolve(HookResult.refuse("billing_active")) });
    await expect(dispatcher([allow, refuse, later]).hooks.deletionGuard(workspaceDeletion)).resolves.toEqual({
      outcome: "refuse",
      code: "billing_active",
    });
  });

  it("allows when every module allows", async () => {
    const allow = module("allow", { deletionGuard: () => HookResult.allow() });
    await expect(dispatcher([allow, allow]).hooks.deletionGuard(workspaceDeletion)).resolves.toEqual({ outcome: "allow" });
  });

  it("treats a refusal outside the closed list as a failure of the hook", async () => {
    const outside = module("outside", { deletionGuard: () => HookResult.refuse("made_up" as "billing_active") });
    const { hooks, logger } = dispatcher([outside]);
    expect((await failure(hooks.deletionGuard(workspaceDeletion))).code).toBe("unavailable");
    expect(logger.entries[0]?.fields).toMatchObject({ hook: "deletionGuard", reason: "invalid_result" });
  });

  it("treats a refusal the module did not declare as a failure of the hook", async () => {
    const undeclared = module("undeclared", { deletionGuard: () => HookResult.refuse("billing_active") }, {});
    const { hooks, logger } = dispatcher([undeclared]);
    expect((await failure(hooks.deletionGuard(workspaceDeletion))).code).toBe("unavailable");
    expect(logger.entries[0]?.fields).toMatchObject({ hook: "deletionGuard", reason: "invalid_result" });
  });

  it("fails closed on a throw, an answer that is not a result and a hang", async () => {
    const cases: ServerHooks[] = [
      {
        deletionGuard: () => {
          throw new Error("x");
        },
      },
      { deletionGuard: () => ({ outcome: "maybe" }) as never },
      { deletionGuard: hanging },
    ];
    for (const hooks of cases) {
      expect((await failure(dispatcher([module("m", hooks)]).hooks.deletionGuard(workspaceDeletion))).code).toBe("unavailable");
    }
  });

  it("passes each hook the plain values of the request, frozen", async () => {
    const received: unknown[] = [];
    const spy = module("spy", {
      deletionGuard: (input) => {
        received.push(input);
        return HookResult.allow();
      },
    });
    await dispatcher([spy]).hooks.deletionGuard(workspaceDeletion);
    expect(received[0]).toEqual(workspaceDeletion);
    expect(received[0]).not.toBe(workspaceDeletion);
    expect(Object.isFrozen(received[0])).toBe(true);
  });
});

describe("the registration policy", () => {
  it("collapses every refusal reason to registration_refused", async () => {
    expect(REGISTRATION_REFUSAL_CODE).toBe("registration_refused");
    for (const reason of ["disposable_domain", "blocked", "anything else"]) {
      const refuse = module("refuse", { registrationPolicy: () => HookResult.refuse(reason) });
      await expect(dispatcher([refuse]).hooks.registrationPolicy(registration)).resolves.toEqual({
        outcome: "refuse",
        code: "registration_refused",
      });
    }
  });

  it("refuses when one of two modules refuses, whichever comes first", async () => {
    const allow = module("allow", { registrationPolicy: () => HookResult.allow() });
    const refuse = module("refuse", { registrationPolicy: () => Promise.resolve(HookResult.refuse("blocked")) });
    for (const modules of [[allow, refuse], [refuse, allow]]) {
      expect((await dispatcher(modules).hooks.registrationPolicy(registration)).outcome).toBe("refuse");
    }
  });

  it("fails closed on a throw, a hang and an unusable answer", async () => {
    const cases: ServerHooks[] = [
      {
        registrationPolicy: () => {
          throw new Error("x");
        },
      },
      { registrationPolicy: hanging },
      { registrationPolicy: () => HookResult.refuse("") },
      { registrationPolicy: () => undefined as never },
    ];
    for (const hooks of cases) {
      expect((await failure(dispatcher([module("m", hooks)]).hooks.registrationPolicy(registration))).code).toBe("unavailable");
    }
  });
});

describe("the client error-report source", () => {
  const port = (dsn: ClientErrorReportPort["dsn"]): ClientErrorReportPort => ({ available: true, dsn });

  it("supplies the DSN the source answers", async () => {
    const seen: unknown[] = [];
    const { hooks } = dispatcher([], {
      port: port((request) => {
        seen.push(request);
        return Promise.resolve("https://public@reports.example/1");
      }),
    });
    await expect(hooks.clientErrorReportDsn({ accountId: "a1", workspaceId: "w1" })).resolves.toBe("https://public@reports.example/1");
    expect(seen).toEqual([{ accountId: "a1", workspaceId: "w1" }]);
  });

  it("degrades to no DSN when the source rejects, throws, hangs or answers nonsense", async () => {
    const sources = [
      port(() => Promise.reject(new Error("x"))),
      port(() => {
        throw new Error("x");
      }),
      port(hanging),
      port(() => Promise.resolve(42 as unknown as string)),
      port(() => Promise.resolve("")),
    ];
    for (const source of sources) {
      const { hooks } = dispatcher([], { port: source });
      await expect(hooks.clientErrorReportDsn({ accountId: "a1", workspaceId: undefined })).resolves.toBeNull();
    }
  });

  it("does not call a source that reports itself unavailable", async () => {
    let calls = 0;
    const { hooks } = dispatcher([], {
      port: {
        available: false,
        dsn: () => {
          calls += 1;
          return Promise.resolve("https://public@reports.example/1");
        },
      },
    });
    await expect(hooks.clientErrorReportDsn({ accountId: "a1", workspaceId: undefined })).resolves.toBeNull();
    expect(calls).toBe(0);
  });
});

describe("invalidHookRefusals", () => {
  it("accepts the codes of the closed list and nothing else", () => {
    expect(invalidHookRefusals({})).toBeUndefined();
    expect(invalidHookRefusals({ deletionGuard: ["billing_active"] })).toBeUndefined();
    expect(invalidHookRefusals({ deletionGuard: ["subscription_active"] })).toContain("subscription_active");
    expect(invalidHookRefusals({ deletionGuard: "billing_active" })).toBeDefined();
    expect(invalidHookRefusals({ seatCheck: ["billing_active"] })).toBeDefined();
    expect(invalidHookRefusals(null)).toBeDefined();
  });
});
