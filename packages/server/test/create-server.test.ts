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
