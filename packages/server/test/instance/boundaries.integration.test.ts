import { classifyOperations, loadOpenApiDocument, type ClassifiedOperation } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INSTANCE_AUDIT_ACTION_NAMES } from "@slugbase/core";
import { FIXTURES } from "../contract/fixtures.ts";
import { HOOK_TIMEOUT_MS, bearer, workspaceHarness, type World } from "../workspaces/support.ts";
import { callOperation, clearInstanceEvents, codeOf, enrolSecondFactor, instanceEvents, signIn, signInAdmin, type Principal } from "./support.ts";

// The boundaries of the instance-admin role across every /instance operation (doc 08 section 3.3 and 3.5, doc 10 T1,
// T3, T15 and T18, Q44 and Q45). The operations are read from the committed openapi.json when the suite runs, so an
// operation added under /instance is walked with no edit here; its refusals need no fixture, and the walk of the full
// admin falls back to an empty request for one no fixture names.

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());
beforeEach(() => clearInstanceEvents(database()));

const document = loadOpenApiDocument() as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch"]);
const INSTANCE_PREFIX = "/api/v1/instance";

/** The operations under /instance counted straight from the paths of the document, apart from the classifier the walk uses. */
function documentedInstanceOperations(): number {
  return Object.entries(document.paths)
    .filter(([path]) => path === INSTANCE_PREFIX || path.startsWith(`${INSTANCE_PREFIX}/`))
    .reduce((sum, [, item]) => sum + Object.keys(item).filter((method) => HTTP_METHODS.has(method)).length, 0);
}

const instanceOperations: readonly ClassifiedOperation[] = classifyOperations(document).operations.filter(
  (operation) => operation.path === INSTANCE_PREFIX || operation.path.startsWith(`${INSTANCE_PREFIX}/`),
);

/** Policy refusals: the answers of the chain before any handler. A full admin must get none of them. */
const POLICY_REFUSALS = new Set(["unauthenticated", "mfa_required", "reauth_required", "forbidden"]);
function declares(operation: ClassifiedOperation, status: number): boolean {
  return Object.hasOwn(document.paths[operation.path]?.[operation.method]?.responses ?? {}, String(status));
}

describe("the walk covers every /instance operation of openapi.json", () => {
  it("walks as many operations as the document declares under /instance, every one with the instanceAdmin policy", () => {
    expect(instanceOperations.length).toBe(documentedInstanceOperations());
    // A floor that stops an emptied document or a broken path filter from passing an empty walk; a larger count is fine.
    expect(instanceOperations.length).toBeGreaterThanOrEqual(14);
    expect(instanceOperations.filter((operation) => operation.policy !== "instanceAdmin").map((operation) => operation.operationId)).toEqual([]);
    expect(instanceOperations.filter((operation) => operation.kind !== "process")).toEqual([]);
  });
});

describe("everyone the instanceAdmin policy excludes, on every /instance operation", () => {
  let world: World;
  let ordinary: Principal;
  let withoutFactor: Principal;
  let pending: Principal;
  let tokenValue: string;

  beforeAll(async () => {
    world = harness.serve();
    // An account that differs from an admin in nothing but the flag: verified, with a second factor, and re-authenticated just now.
    ordinary = await signIn(database(), world, { flag: false, mfa: true, reauth: true });
    // An instance admin that differs from a full one in nothing but the second factor.
    withoutFactor = await signIn(database(), world, { flag: true, mfa: false, reauth: true });
    // An instance admin that signed in with a factor enrolled and has not entered the code.
    pending = await signIn(database(), world, { flag: true, mfa: true, partial: true });
    // The token of an instance admin who has the factor and the flag: the policy excludes a token whatever its account is.
    const holder = await harness.person(world);
    await database().owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${holder.account.id}, true)`;
      await tx`UPDATE accounts SET is_instance_admin = true WHERE id = ${holder.account.id}`;
    });
    await enrolSecondFactor(database(), holder.account.id);
    const { workspaceId } = await harness.workspaceOf([{ person: holder, role: "owner" }]);
    tokenValue = await harness.token(workspaceId, holder, "read-write");
  }, HOOK_TIMEOUT_MS);

  const scenarios: readonly {
    readonly name: string;
    readonly status: number;
    readonly code: string;
    readonly credential: () => { cookie?: string; headers?: Record<string, string> };
  }[] = [
    { name: "anonymous", status: 401, code: "unauthenticated", credential: () => ({}) },
    { name: "an ordinary account", status: 403, code: "forbidden", credential: () => ({ cookie: ordinary.cookie }) },
    { name: "an API token of an admin", status: 403, code: "forbidden", credential: () => ({ headers: bearer(tokenValue) }) },
    { name: "a session waiting for its second factor", status: 401, code: "mfa_required", credential: () => ({ cookie: pending.cookie }) },
    { name: "an instance admin without a second factor", status: 403, code: "forbidden", credential: () => ({ cookie: withoutFactor.cookie }) },
  ];

  it.each(scenarios)("answers $name with $status $code, declared by the operation, and writes no event", async ({ status, code, credential }) => {
    for (const operation of instanceOperations) {
      const { cookie, headers } = credential();
      const response = await callOperation(world, operation, cookie, headers);
      expect([response.status, await codeOf(response)], operation.operationId).toEqual([status, code]);
      expect(declares(operation, response.status), `${operation.operationId} does not declare ${String(status)}`).toBe(true);
    }
    expect(await instanceEvents(database())).toEqual([]);
  });

  it("answers an ordinary account and an admin without a factor 403 on a re-authenticating operation whether or not the session re-authenticated", async () => {
    const stale = await signIn(database(), world, { flag: false, mfa: true, reauth: false });
    const staleWithoutFactor = await signIn(database(), world, { flag: true, mfa: false, reauth: false });
    const reauthenticating = instanceOperations.filter((operation) => operation.reauth);
    expect(reauthenticating.length).toBeGreaterThan(0);
    for (const operation of reauthenticating) {
      for (const principal of [stale, staleWithoutFactor]) {
        const response = await callOperation(world, operation, principal.cookie);
        expect([response.status, await codeOf(response)], operation.operationId).toEqual([403, "forbidden"]);
      }
    }
    expect(await instanceEvents(database())).toEqual([]);
  });
});

describe("an instance admin with a second factor on a complete session, on every /instance operation", () => {
  let world: World;

  beforeAll(() => {
    world = harness.serve();
  });

  it("is answered 401 reauth_required by each operation that declares re-authentication until the session re-authenticates", async () => {
    const reauthenticating = instanceOperations.filter((operation) => operation.reauth);
    expect(reauthenticating.length).toBeGreaterThan(0);
    const stale = await signInAdmin(database(), world, { reauth: false });
    for (const operation of reauthenticating) {
      const response = await callOperation(world, operation, stale.cookie);
      expect([response.status, await codeOf(response)], operation.operationId).toEqual([401, "reauth_required"]);
      expect(declares(operation, response.status)).toBe(true);
    }
    expect(await instanceEvents(database())).toEqual([]);
  });

  it("reaches the handler of each operation and is answered as the operation documents, with an event in the instance stream for each 2xx", async () => {
    for (const operation of instanceOperations) {
      // An account of its own for each, so that the request of one cannot end the session of the next. A session that has not re-authenticated
      // calls an operation that does not declare it, which shows that the declaration is where the requirement is.
      const admin = await signInAdmin(database(), world, { reauth: operation.reauth });
      const before = (await instanceEvents(database())).length;

      const response = await callOperation(world, operation, admin.cookie);

      const code = response.ok ? undefined : await codeOf(response);
      expect(code === undefined || !POLICY_REFUSALS.has(code), `${operation.operationId} was refused by policy: ${String(response.status)} ${code ?? ""}`).toBe(true);
      expect(declares(operation, response.status), `${operation.operationId} answered ${String(response.status)}, which it does not declare`).toBe(true);
      const fixture = Object.hasOwn(FIXTURES, operation.operationId) ? FIXTURES[operation.operationId] : undefined;
      if (fixture !== undefined) {
        const lowestSuccess = Object.keys(document.paths[operation.path]?.[operation.method]?.responses ?? {})
          .map(Number)
          .filter((status) => status >= 200 && status < 300)
          .sort((a, b) => a - b)[0];
        expect(response.status, operation.operationId).toBe(fixture.status ?? lowestSuccess);
      }
      if (response.ok) {
        const after = await instanceEvents(database());
        const written = after.slice(before);
        expect(written.length, `${operation.operationId} answered ${String(response.status)} and wrote no instance event`).toBeGreaterThan(0);
        expect(written.every((event) => event.actor_account_id === admin.accountId && (INSTANCE_AUDIT_ACTION_NAMES as readonly string[]).includes(event.action))).toBe(true);
      }
    }
  }, HOOK_TIMEOUT_MS);
});
