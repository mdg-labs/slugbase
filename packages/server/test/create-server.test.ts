import { unconfigured, type Adapters } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CHAIN_STAGES,
  CompositionError,
  createServer,
  type ModuleContext,
  type ServerModule,
} from "../src/create-server.ts";
import { HookResult } from "../src/hooks/index.ts";
import { defineJob, defineSchedule } from "../src/worker/index.ts";
import { adapters, fakeDatabase, operation, recordingLogger, serverConfig } from "./support.ts";

const noPayload = z.object({});

function job(name: string) {
  return defineJob({ name, payload: noPayload, handle: () => Promise.resolve() });
}

function compose(modules: readonly ServerModule[] = [], overrides: { adapters?: Adapters } = {}) {
  const logger = recordingLogger();
  const database = fakeDatabase();
  const server = createServer({
    config: serverConfig(),
    adapters: overrides.adapters ?? adapters(),
    modules,
    migrations: [],
    logger,
    database,
  });
  return { server, logger, database };
}

function failure(run: () => unknown): CompositionError {
  try {
    run();
  } catch (error) {
    if (error instanceof CompositionError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a CompositionError");
}

const pingModule = (name = "ping", path = "/api/v1/ping", operationId = "ping"): ServerModule => ({
  name,
  register: () => ({
    routes: [{ operation: operation("get", path, operationId), handler: () => Response.json({ pong: name }) }],
  }),
});

describe("createServer", () => {
  it("composes the unconfigured defaults with no modules", async () => {
    const { server } = compose();
    expect(server.stages).toEqual([...CHAIN_STAGES]);
    expect((await server.fetch(new Request("http://localhost/api/v1/ping"))).status).toBe(404);
  });

  it("names the port of a missing adapter and refuses to compose", () => {
    const incomplete = { ...unconfigured(), secretBox: undefined } as unknown as Adapters;
    const error = failure(() => compose([], { adapters: incomplete }));
    expect(error.code).toBe("missing_adapter");
    expect(error.message).toContain("secretBox");
    expect(error.message).not.toContain("mail,");
  });

  it("names every missing port, and treats a value that is not a port as missing", () => {
    const incomplete = { ...unconfigured(), mail: undefined, egress: {}, rateLimit: null } as unknown as Adapters;
    const error = failure(() => compose([], { adapters: incomplete }));
    expect(error.message).toContain("mail, egress, rateLimit");
  });

  it("serves the routes a module registers through the chain", async () => {
    const { server } = compose([pingModule()]);
    const response = await server.fetch(new Request("http://localhost/api/v1/ping"));
    expect(await response.json()).toEqual({ pong: "ping" });
  });

  it("gives modules the logger, the ports and the tenant helper of core code, and no stage", async () => {
    const received: ModuleContext[] = [];
    const logger = recordingLogger();
    const ports = adapters();
    const database = fakeDatabase();
    const module: ServerModule = {
      name: "probe",
      register: (context) => {
        received.push(context);
        return {};
      },
    };
    const server = createServer({
      config: serverConfig(),
      adapters: ports,
      modules: [module],
      migrations: [],
      logger,
      database,
    });
    const [context] = received;
    expect(context?.logger).toBe(logger);
    expect(context?.adapters.mail).toBe(ports.mail);
    expect(Object.isFrozen(context?.adapters)).toBe(true);
    await expect(context?.withTenant({ accountId: "a", requestId: "r" }, () => Promise.resolve(7))).resolves.toBe(7);
    expect(Object.keys(context ?? {}).sort()).toEqual(["adapters", "config", "logger", "withTenant"]);
    expect(server.stages).toEqual([...CHAIN_STAGES]);
  });

  it("keeps the stage order whatever the modules contribute", () => {
    const { server } = compose([pingModule("a"), pingModule("b", "/api/v1/other", "other")]);
    expect(server.stages).toEqual([...CHAIN_STAGES]);
  });

  it("collects the jobs, schedules and migration sets of the modules in order", () => {
    const first = { name: "cloud", folder: "/a", bookkeepingTable: "migrations_cloud" };
    const second = { name: "extra", folder: "/b", bookkeepingTable: "migrations_extra" };
    const given = { name: "given", folder: "/c", bookkeepingTable: "migrations_given" };
    const module: ServerModule = {
      name: "billing",
      register: () => ({
        jobs: [job("billing.reconcile")],
        schedules: [defineSchedule({ name: "nightly", cron: "0 3 * * *", job: "billing.reconcile" })],
        migrations: [first, second],
      }),
    };
    const server = createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [module],
      migrations: [given],
      logger: recordingLogger(),
      database: fakeDatabase(),
    });
    expect(server.jobs.map((job) => job.name)).toEqual(["billing.reconcile"]);
    expect(server.schedules.map((schedule) => schedule.name)).toEqual(["nightly"]);
    expect(server.migrations).toEqual([given, first, second]);
  });

  it("refuses conflicting modules and closes the pool it opened", () => {
    const conflicts: [string, ServerModule[], string][] = [
      ["duplicate_module", [pingModule(), pingModule()], "ping"],
      ["duplicate_route", [pingModule("a"), pingModule("b", "/api/v1/ping", "other")], "GET /api/v1/ping"],
      ["duplicate_route", [pingModule("a"), pingModule("b", "/api/v1/{name}", "ping")], "ping"],
      ["invalid_module", [{ name: "", register: () => ({}) }], "name"],
      [
        "module_failed",
        [
          {
            name: "broken",
            register: () => {
              throw new Error("no configuration");
            },
          },
        ],
        "broken",
      ],
      [
        "duplicate_job",
        [
          {
            name: "jobs",
            register: () => ({
              jobs: [job("same.job"), job("same.job")],
            }),
          },
        ],
        "same.job",
      ],
      [
        "unknown_job",
        [{ name: "orphan", register: () => ({ schedules: [defineSchedule({ name: "s", cron: "* * * * *", job: "absent.job" })] }) }],
        "absent.job",
      ],
      [
        "duplicate_schedule",
        [
          {
            name: "twice",
            register: () => ({
              jobs: [job("some.job")],
              schedules: [
                defineSchedule({ name: "s", cron: "* * * * *", job: "some.job" }),
                defineSchedule({ name: "s", cron: "* * * * *", job: "some.job" }),
              ],
            }),
          },
        ],
        "s is registered twice",
      ],
      [
        "invalid_schedule",
        [
          {
            name: "wrong",
            register: () => ({
              jobs: [job("some.job")],
              schedules: [defineSchedule({ name: "s", cron: "* * * * *", job: "some.job", payload: { extra: "x" } })],
            }),
          },
        ],
        "some.job",
      ],
    ];
    for (const [code, modules, mention] of conflicts) {
      const database = fakeDatabase();
      const error = failure(() =>
        createServer({
          config: serverConfig(),
          adapters: adapters(),
          modules,
          migrations: [],
          logger: recordingLogger(),
          database,
        }),
      );
      expect(error.code).toBe(code);
      expect(error.message).toContain(mention);
      expect(database.closed.count).toBe(1);
    }
  });
});

describe("the hooks of modules", () => {
  const seat = { workspaceId: "w1", accountId: "a1", invitationId: "i1" };
  const registration = { email: "someone@example.com", path: "oidc" } as const;

  function hookServer(modules: readonly ServerModule[], hookTimeoutMs = 25) {
    const probe: ServerModule = {
      name: "probe",
      register: () => ({
        routes: [
          {
            operation: operation("get", "/api/v1/probe", "probe"),
            handler: async (context) => {
              const hooks = context.get("hooks");
              if (hooks === undefined) {
                throw new Error("no hooks in the handler");
              }
              const limit = await hooks.seatLimit(seat, 5);
              const registrationOutcome = await hooks.registrationPolicy(registration);
              return Response.json({ limit, registrationOutcome });
            },
          },
        ],
      }),
    };
    return createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [probe, ...modules],
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
      hookTimeoutMs,
    });
  }

  const get = (server: ReturnType<typeof hookServer>) => server.fetch(new Request("http://localhost/api/v1/probe"));

  it("leaves CE behaviour unchanged with no hook registered", async () => {
    const response = await get(hookServer([]));
    expect(await response.json()).toEqual({ limit: 5, registrationOutcome: { outcome: "allow" } });
  });

  it("consults the hooks of every module, the lowest seat limit winning", async () => {
    const server = hookServer([
      { name: "a", hooks: { seatCheck: () => ({ seatLimit: 8 }) }, register: () => ({}) },
      { name: "b", hooks: { seatCheck: () => ({ seatLimit: 2 }), registrationPolicy: () => HookResult.refuse("blocked") }, register: () => ({}) },
    ]);
    expect(await (await get(server)).json()).toEqual({
      limit: 2,
      registrationOutcome: { outcome: "refuse", code: "registration_refused" },
    });
  });

  it("answers 503 unavailable when a module's hook hangs", async () => {
    const server = hookServer([{ name: "slow", hooks: { seatCheck: () => new Promise(() => undefined) }, register: () => ({}) }]);
    const response = await get(server);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  });

  it("refuses to compose a module whose hooks are not functions or are not declared by CE", () => {
    const bad: unknown[] = [{ seatCheck: "yes" }, { archive: () => undefined }, "hooks", null];
    for (const hooks of bad) {
      const module = { name: "bad", hooks, register: () => ({}) } as unknown as ServerModule;
      const database = fakeDatabase();
      const error = failure(() =>
        createServer({ config: serverConfig(), adapters: adapters(), modules: [module], migrations: [], logger: recordingLogger(), database }),
      );
      expect(error.code).toBe("invalid_hook");
      expect(error.message).toContain("bad");
      expect(database.closed.count).toBe(1);
    }
  });

  it("refuses to compose a module that declares a deletion refusal outside the closed list", () => {
    const bad: unknown[] = [{ deletionGuard: ["subscription_active"] }, { deletionGuard: "billing_active" }, { archive: [] }, null];
    for (const hookRefusals of bad) {
      const module = {
        name: "bad",
        hooks: { deletionGuard: () => HookResult.refuse("billing_active") },
        hookRefusals,
        register: () => ({}),
      } as unknown as ServerModule;
      const database = fakeDatabase();
      const error = failure(() =>
        createServer({ config: serverConfig(), adapters: adapters(), modules: [module], migrations: [], logger: recordingLogger(), database }),
      );
      expect(error.code).toBe("invalid_hook");
      expect(error.message).toContain("bad");
      expect(database.closed.count).toBe(1);
    }
  });

  it("composes a module whose declared deletion refusals are on the closed list", () => {
    const module: ServerModule = {
      name: "billing",
      hooks: { deletionGuard: () => HookResult.refuse("billing_active") },
      hookRefusals: { deletionGuard: ["billing_active"] },
      register: () => ({}),
    };
    expect(() =>
      createServer({ config: serverConfig(), adapters: adapters(), modules: [module], migrations: [], logger: recordingLogger(), database: fakeDatabase() }),
    ).not.toThrow();
  });
});
