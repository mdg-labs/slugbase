import { classifyOperations, createProbe, loadOpenApiDocument, runApiMatrix, type Probe } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { route } from "../../src/routes/register.ts";
import { recordingLogger, serverConfig } from "../support.ts";
import { buildDocument, type TestDocument } from "./build-document.ts";
import { readOperations } from "./document.ts";
import { seedAccount } from "../auth/support.ts";
import { FIXTURES, WALKER_ACCOUNT } from "./fixtures.ts";
import { matrixRequest } from "./matrix.ts";
import { getProbeAdminRow, getProbeRow, probeFixtures, probeModule, probeOperations } from "./probe-module.ts";
import { createStubWorld, type StubWorld } from "./stubs.ts";
import { appUrl, tenantDatabase } from "./support.ts";
import type { PolicyHooks } from "./walker.ts";
import { walkContract } from "./walker.ts";

// The contract tests of doc 04 section 1.3 and the cross-tenant matrix of doc 08
// section 3.3 in API mode, both over an in-process server (doc 10 T1, T3). The
// first suite walks the committed document against the server as composed. The
// others walk and run the matrix over a test module whose operations carry
// every policy the walker's hooks act on, because the committed document holds
// no operation that needs a principal yet.

const HOOK_TIMEOUT_MS = 300_000;

const database = useTestDatabase();
let probe: Probe;
let world: StubWorld;

beforeAll(async () => {
  probe = await createProbe(database(), { table: "contract_probe", repository: "contract_probe" });
  world = createStubWorld(probe.fixture);
}, HOOK_TIMEOUT_MS);

function serve(modules: readonly ServerModule[], document?: TestDocument): Server {
  // The walker signs in once for each operation that needs a session, more often than the default limit of one address allows.
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), RATE_LIMIT_LOGIN_IP: "100/min" });
  return createServer({
    config,
    adapters: world.adapters(config),
    modules,
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    ...(document === undefined ? {} : { openApiDocument: document }),
  });
}

/** The constructed Critical of doc 10 section 6: the handler looks the row up as the table owner, in every workspace. */
async function sneakyLookup({ params }: { params: { rowId: string } }): Promise<{ status: 200; body: { id: string; label: string } }> {
  for (const workspaceId of [probe.fixture.a.id, probe.fixture.b.id]) {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return tx.unsafe<{ id: string; label: string }[]>(`SELECT id, label FROM ${probe.table} WHERE id = $1`, [params.rowId]);
    });
    const row = rows[0];
    if (row !== undefined) {
      return { status: 200, body: { id: row.id, label: row.label } };
    }
  }
  throw new ProblemError("not_found", "No such row.");
}

const origin = serverConfig({ NODE_ENV: "test" }).APP_ORIGIN;
const committed = loadOpenApiDocument();

describe("the walker over the committed document", () => {
  // The committed document declares the sign-in operations, so the walker signs in as a real account and
  // sends the session cookie it is given where a policy needs a principal. Each such operation gets an
  // account of its own: the valid request of the sign-out ends the session it is made with, and that of
  // "sign out everywhere" ends every other session of the account.
  async function sessionHooks(server: Server): Promise<PolicyHooks> {
    await seedAccount(database(), WALKER_ACCOUNT);
    const needsReauth = new Set(readOperations(committed).operations.filter((operation) => operation.reauth === true).map((operation) => operation.operationId));
    const signIn = async (email: string, reauthenticate: boolean): Promise<string> => {
      await seedAccount(database(), { email, password: WALKER_ACCOUNT.password });
      const response = await server.fetch(
        new Request(new URL("/api/v1/auth/login", origin), {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email, password: WALKER_ACCOUNT.password, remember: false }),
        }),
      );
      const cookie = /^(__Host-slugbase_session=[A-Za-z0-9_-]{43});/.exec(response.headers.get("set-cookie") ?? "")?.[1];
      if (response.status !== 200 || cookie === undefined) {
        throw new Error(`the walker could not sign in: ${String(response.status)}`);
      }
      if (reauthenticate) {
        const reauth = await server.fetch(
          new Request(new URL("/api/v1/me/reauth", origin), {
            method: "POST",
            headers: { origin, "content-type": "application/json", cookie },
            body: JSON.stringify({ password: WALKER_ACCOUNT.password }),
          }),
        );
        if (reauth.status !== 204) {
          throw new Error(`the walker could not re-authenticate: ${String(reauth.status)}`);
        }
      }
      return cookie;
    };
    const cookies = new Map<string, string>();
    const stale = new Map<string, string>();
    for (const { operationId, kind } of classifyOperations(committed).operations) {
      if (kind !== "account-level") {
        continue;
      }
      const email = `walker-${operationId}@example.test`.toLowerCase();
      cookies.set(operationId, await signIn(email, needsReauth.has(operationId)));
      if (needsReauth.has(operationId)) {
        // Its own account: the valid request of the operation ends the sessions of the account it is made for.
        stale.set(operationId, await signIn(`walker-${operationId}-stale@example.test`.toLowerCase(), false));
      }
    }
    const credentialsOf = (held: ReadonlyMap<string, string>, operationId: string) => {
      const cookie = held.get(operationId);
      if (cookie === undefined) {
        throw new Error(`the walker holds no session for ${operationId}`);
      }
      return { headers: { cookie } };
    };
    return {
      ...world.hooks,
      authorized: ({ operationId }) => credentialsOf(cookies, operationId),
      withoutReauth: ({ operationId }) => credentialsOf(stale, operationId),
    };
  }

  it("calls every operation of openapi.json and finds it as declared", async () => {
    const operations = classifyOperations(committed).operations;
    expect(Object.keys(FIXTURES).sort()).toEqual(operations.map((operation) => operation.operationId).sort());

    const server = serve([]);
    const hooks = await sessionHooks(server);
    const report = await walkContract({ document: committed, send: (request) => server.fetch(request), origin, fixtures: FIXTURES, hooks });
    expect(report.failures).toEqual([]);
    expect(report.operations).toBe(operations.length);
    expect(report.operations).toBeGreaterThan(0);
    // One valid request for each anonymous operation and for the sign-in; each of the ten operations that need a session
    // also answers 401 without one, and each of the two that declare re-authentication answers 401 reauth_required without it.
    expect(report.calls).toBe(operations.length + 12);
  });
});

describe("the hooks over a test module", () => {
  const document = buildDocument(probeOperations, committed);

  it("run for every operation with a policy that needs a principal, and the server answers each as declared", async () => {
    const counted: Record<keyof PolicyHooks, number> = { authorized: 0, withoutReauth: 0, tooLowRole: 0, readOnlyToken: 0, withoutEntitlement: 0, workspaceA: 0 };
    const count = <K extends keyof PolicyHooks>(name: K): PolicyHooks[K] =>
      ((operation: Parameters<PolicyHooks[K]>[0]) => {
        counted[name] += 1;
        return world.hooks[name](operation);
      }) as PolicyHooks[K];
    const hooks: PolicyHooks = {
      authorized: count("authorized"),
      withoutReauth: count("withoutReauth"),
      tooLowRole: count("tooLowRole"),
      readOnlyToken: count("readOnlyToken"),
      withoutEntitlement: count("withoutEntitlement"),
      workspaceA: count("workspaceA"),
    };

    const server = serve([probeModule(probe, world)], document);
    const report = await walkContract({ document, send: (request) => server.fetch(request), origin, fixtures: probeFixtures(probe), hooks });
    expect(report.failures).toEqual([]);
    expect(report.operations).toBe(probeOperations.length);
    expect(counted).toEqual({
      authorized: 8,
      // no operation of the test module declares re-authentication
      withoutReauth: 0,
      // every policy but the account one has a role below it
      tooLowRole: 7,
      // the one operation with a write scope
      readOnlyToken: 1,
      // the one operation that declares an entitlement
      withoutEntitlement: 1,
      // the three operations that take the identifier of a row
      workspaceA: 3,
    });
    // the valid request and the one without credentials of each operation, and one request for each run of another hook
    expect(report.calls).toBe(8 + 8 + 7 + 1 + 1 + 3);
  });
});

describe("the cross-tenant matrix in API mode over the server", () => {
  const document = buildDocument(probeOperations, committed);
  const mapping = { rowId: "bookmark" } as const;

  it("passes for handlers that read inside the tenant transaction", async () => {
    const server = serve([probeModule(probe, world)], document);
    const report = await runApiMatrix({
      document,
      fixture: probe.fixture,
      mapping,
      request: matrixRequest({ send: (request) => server.fetch(request), origin, fixtures: probeFixtures(probe), credentialsOf: (principal) => world.credentialsOf(principal) }),
    });
    expect(report.failures).toEqual([]);
    expect(report.classified.byKind["tenant-scoped"]).toBe(6);
    // three principals of A against the two rows of B, on each of the three operations that take a row; once on the three that take none
    expect(report.attempts).toBe(3 * 6 + 3 * 3);
  });

  it("fails an operation that loads the row by id outside the tenant transaction", async () => {
    const sneaky: ServerModule = {
      name: "sneaky",
      register: () => ({
        authenticators: world.authenticators,
        routes: [
          route(getProbeRow).handle(sneakyLookup),
        ],
      }),
    };
    const only = buildDocument([getProbeRow], committed);
    const server = serve([sneaky], only);
    const report = await runApiMatrix({
      document: only,
      fixture: probe.fixture,
      mapping,
      request: matrixRequest({ send: (request) => server.fetch(request), origin, fixtures: probeFixtures(probe), credentialsOf: (principal) => world.credentialsOf(principal) }),
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["unexpected_status", "leaked_name"]));
    expect(report.failures.filter((failure) => failure.kind === "unexpected_status")).toHaveLength(6);
  });

  it("fails an admin operation that loads the row by id outside the tenant transaction, for the principals the policy admits only", async () => {
    const sneaky: ServerModule = {
      name: "sneaky-admin",
      register: () => ({
        authenticators: world.authenticators,
        routes: [
          route(getProbeAdminRow).handle(sneakyLookup),
        ],
      }),
    };
    const only = buildDocument([getProbeAdminRow], committed);
    const server = serve([sneaky], only);
    const report = await runApiMatrix({
      document: only,
      fixture: probe.fixture,
      mapping,
      request: matrixRequest({ send: (request) => server.fetch(request), origin, fixtures: probeFixtures(probe), credentialsOf: (principal) => world.credentialsOf(principal) }),
    });
    expect(new Set(report.failures.map((failure) => failure.kind))).toEqual(new Set(["unexpected_status", "leaked_name"]));
    // the member is refused by stage 9 before the handler runs; the admin and the owner reach it
    const unexpected = report.failures.filter((failure) => failure.kind === "unexpected_status");
    expect(unexpected).toHaveLength(4);
    expect(unexpected.every((failure) => /^as (admin|owner) of A/.test(failure.detail))).toBe(true);
  });
});
