import { LimitedEntitlementSource } from "@slugbase/testing";
import { classifyOperations, createProbe, loadOpenApiDocument, PROBE_INSTANCE_ADMIN, runApiMatrix, runTokenMatrix, type ApiCall, type ApiResponse, type MatrixFailure, type Probe } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { beforeAll, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../../vitest.shared.ts";
import { createAccountOnlyTenantResolver } from "../../src/auth/tenant-resolver.ts";
import { createServer, type Server, type ServerModule } from "../../src/create-server.ts";
import { HookResult } from "../../src/hooks/index.ts";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { runMigrations } from "../../src/migrate/index.ts";
import { route } from "../../src/routes/register.ts";
import { urlOf } from "../migrate/support.ts";
import { recordingLogger, serverConfig } from "../support.ts";
import { buildDocument, type TestDocument } from "./build-document.ts";
import { readOperations, type ContractFailure } from "./document.ts";
import { seedAccount, seedApiToken, seedMembership, seedWorkspace } from "../auth/support.ts";
import { B_INVITATION_ID, B_SLUGS, FIXTURES, UNKNOWN_TAG_ID, UNKNOWN_TEAM_ID, WALKER_ACCOUNT, WALKER_WORKSPACE_ID } from "./fixtures.ts";
import { matrixRequest, tokenMatrixRequest } from "./matrix.ts";
import { getProbeAdminRow, getProbeRow, probeFixtures, probeModule, probeOperations } from "./probe-module.ts";
import { createStubWorld, type StubWorld } from "./stubs.ts";
import { appUrl, tenantDatabase } from "./support.ts";
import type { ContractFixtures, PolicyHooks } from "./walker.ts";
import { walkContract } from "./walker.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What one call of the matrix to the bulk request or its preview was answered when sent as each of the requests that carry its identifiers of workspace B. */
interface VariantStatuses {
  readonly operation: "bulkBookmarks" | "previewBulkBookmarks";
  readonly statuses: Readonly<Record<string, number>>;
  /** How many bookmarks the request that names a bookmark of B in `ids` reports affected, when it is answered 200. */
  readonly affectedById: number | undefined;
  /** How many bookmarks the request whose filter names the folder and the tags of B reports, when it is answered 200. */
  readonly requestedByFilter: number | undefined;
}

type Send = (call: ApiCall) => Promise<ApiResponse>;

function countOf(response: ApiResponse, name: "affected" | "requested"): number | undefined {
  return response.status === 200 && isRecord(response.body) && typeof response.body[name] === "number" ? response.body[name] : undefined;
}

/**
 * Sends one call of the matrix to the bulk request, or to its preview of adding tags, as separate requests, each of which reaches the handler with some of the
 * identifiers of workspace B: `ids` with a pin, the folder of B with a move to it, the tags of B with an add, the folder and the tags of B in the filter with a pin and
 * with a move. The requests are made at the same time: none of them changes anything a sibling reads (each is refused or skips the identifiers of B). The answer returned is the
 * one the matrix judges (the folder action, and for the preview the tags), and every answer is recorded in `variants`.
 */
async function sendVariants(call: ApiCall, send: Send, sendByFilter: Send, variants: VariantStatuses[]): Promise<ApiResponse> {
  const fields = isRecord(call.body) ? call.body : {};
  const given = isRecord(fields.filter) ? fields.filter : {};
  const filter = { folderId: given.folderId, tag: given.tag };
  const using = (body: Record<string, unknown>): ApiCall => ({ ...call, body });
  if (call.operation.operationId === "previewBulkBookmarks") {
    const [byIds, byFilter] = await Promise.all([send(using({ ids: fields.ids, tagIds: fields.tagIds })), sendByFilter(using({ filter, tagIds: fields.tagIds }))]);
    variants.push({ operation: "previewBulkBookmarks", statuses: { byIds: byIds.status, byFilter: byFilter.status }, affectedById: undefined, requestedByFilter: undefined });
    return byIds;
  }
  const [skippedById, folderOfB, tagsOfB, filterOfB, filterAndFolderOfB] = await Promise.all([
    send(using({ action: "pin", ids: fields.ids })),
    send(using({ action: "move_to_folder", ids: fields.ids, folderId: fields.folderId })),
    send(using({ action: "add_tags", ids: fields.ids, tagIds: fields.tagIds })),
    sendByFilter(using({ action: "pin", filter })),
    sendByFilter(using({ action: "add_to_folder", filter, folderId: fields.folderId })),
  ]);
  variants.push({
    operation: "bulkBookmarks",
    statuses: { skippedById: skippedById.status, folderOfB: folderOfB.status, tagsOfB: tagsOfB.status, filterOfB: filterOfB.status, filterAndFolderOfB: filterAndFolderOfB.status },
    affectedById: countOf(skippedById, "affected"),
    requestedByFilter: countOf(filterOfB, "requested"),
  });
  return folderOfB;
}

// The contract tests of doc 04 section 1.3 and the cross-tenant matrix of doc 08
// section 3.3 in API mode, both over an in-process server (doc 10 T1, T3). The
// first suite walks the committed document against the server as composed. The
// others walk and run the matrix over a test module whose operations carry
// every policy the walker's hooks act on, because the committed document holds
// no operation that needs a principal yet.

const HOOK_TIMEOUT_MS = 300_000;
const WALK_TIMEOUT_MS = 60_000;
const MATRIX_PARTS = 4;

const database = useTestDatabase();
let probe: Probe;
let world: StubWorld;

beforeAll(async () => {
  // The queues of the jobs a request queues exist once the image entrypoint has run migrate; the walker's deletion of a workspace queues one.
  await runMigrations({ url: urlOf(database().owner) });
  probe = await createProbe(database(), { table: "contract_probe", repository: "contract_probe" });
  world = createStubWorld(probe.fixture);
}, HOOK_TIMEOUT_MS);

function serve(modules: readonly ServerModule[], document?: TestDocument, options: { readonly memberships?: boolean; readonly entitlements?: EntitlementCheck } = {}): Server {
  // The walker signs in once for each operation that needs a session, and calls each of the mfa and reset buckets' operations several times,
  // more often than the default limits of one address allow; the matrix makes a write call for each of its principals on every operation that writes.
  const config = serverConfig({ NODE_ENV: "test", DATABASE_URL: appUrl(database()), RATE_LIMIT_WRITE_IP: "1000/min", RATE_LIMIT_WRITE_ACCOUNT: "1000/min", RATE_LIMIT_LOGIN_IP: "200/min", RATE_LIMIT_MFA_IP: "100/min", RATE_LIMIT_MFA_ACCOUNT: "1000/hour", RATE_LIMIT_RESET_IP: "1000/hour", RATE_LIMIT_BULK_IP: "1000/hour", RATE_LIMIT_BULK_ACCOUNT: "1000/hour" });
  return createServer({
    config,
    // The stub resolver knows the workspaces of the fixture and no session of a real sign-in; the walk of the committed document resolves each
    // walker's workspace from its memberships, as the server does, and reads the entitlements of its workspace from a source that limits nothing.
    adapters:
      options.memberships === true
        ? { ...world.adapters(config), tenantResolver: createAccountOnlyTenantResolver(), entitlements: new LimitedEntitlementSource() }
        : world.adapters(config),
    modules,
    migrations: [],
    logger: recordingLogger(),
    database: tenantDatabase(database()),
    ...(document === undefined ? {} : { openApiDocument: document }),
    ...(options.entitlements === undefined ? {} : { entitlements: options.entitlements }),
    // The stub world names its own instance admin, which the database knows nothing of; the walk of the committed document signs real accounts in and
    // leaves the check to the database.
    ...(options.memberships === true ? {} : { secondFactor: world.secondFactor }),
  });
}

/** The entitlement source of the walks and the matrix: it holds the entitlement the committed document declares, for every account but the ones named. */
function entitlementsExcept(accounts: ReadonlySet<string>): EntitlementCheck {
  return (entitlement, subject) => entitlement === "members.invite" && !accounts.has(subject.accountId);
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

/** The committed document with only the operations named, each under its own path, and everything else of it (the components among them) as it is. */
function documentOf(operationIds: ReadonlySet<string>): unknown {
  if (!isRecord(committed) || !isRecord(committed.paths)) {
    throw new Error("the committed document has no paths");
  }
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(committed.paths)) {
    const kept = isRecord(item) ? Object.entries(item).filter(([, operation]) => isRecord(operation) && typeof operation.operationId === "string" && operationIds.has(operation.operationId)) : [];
    if (kept.length > 0) {
      paths[path] = Object.fromEntries(kept);
    }
  }
  return { ...committed, paths };
}

describe("the walker over the committed document", () => {
  // The committed document declares the sign-in operations, so the walker signs in as a real account and
  // sends the session cookie it is given where a policy needs a principal. Each such operation gets an
  // account of its own: the valid request of the sign-out ends the session it is made with, and that of
  // "sign out everywhere" ends every other session of the account.
  async function sessionHooks(server: Server, unentitled: Set<string>): Promise<PolicyHooks> {
    await seedAccount(database(), WALKER_ACCOUNT);
    const needsReauth = new Set(readOperations(committed).operations.filter((operation) => operation.reauth === true).map((operation) => operation.operationId));
    // The account and the workspace of the walker the last sign-in made a member of a workspace of its own, for the token of an operation that writes.
    const lastOwned: { current?: { readonly accountId: string; readonly workspaceId: string } } = {};
    const signIn = async (email: string, reauthenticate: boolean, member = false, role?: "owner" | "member", entitled = true, instanceAdmin = false): Promise<string> => {
      const account = await seedAccount(database(), { email, password: WALKER_ACCOUNT.password, instanceAdmin });
      if (!entitled) {
        unentitled.add(account.id);
      }
      if (role !== undefined) {
        // A tenant-scoped operation acts in the workspace of the request, which the server resolves from the walker's memberships: its own, with
        // the settings row creating a workspace makes.
        const workspaceId = await seedWorkspace(database(), { name: "Walker's own workspace" });
        await database().owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`;
        });
        await seedMembership(database(), { workspaceId, accountId: account.id, role });
        lastOwned.current = { accountId: account.id, workspaceId };
      }
      if (member) {
        // A token is bound to a workspace of the account, and a session is switched to one, so the walker that does either is a member of its own.
        await database().owner.begin(async (tx) => {
          await tx`SET LOCAL ROLE slugbase_system`;
          await tx`INSERT INTO workspaces (id, name) VALUES (${WALKER_WORKSPACE_ID}, 'Walker workspace') ON CONFLICT DO NOTHING`;
        });
        await seedMembership(database(), { workspaceId: WALKER_WORKSPACE_ID, accountId: account.id, role: "member" });
      }
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
      if (instanceAdmin) {
        // An instance admin needs a second factor besides the flag. The sign-in above came first, so the session is a complete one, as it is after the code is accepted.
        await database().owner.begin(async (tx) => {
          await tx`SELECT set_config('app.account_id', ${account.id}, true)`;
          await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${Buffer.from("sealed")}, mfa_secret_key_id = 'key-1' WHERE id = ${account.id}`;
        });
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
    // The API token of an operation that writes, which may only read: the real token of the walker's own workspace.
    const readOnlyTokens = new Map<string, string>();
    const writing = new Set(readOperations(committed).operations.filter((operation) => operation.scope === "write").map((operation) => operation.operationId));
    const stale = new Map<string, string>();
    const below = new Map<string, string>();
    const without = new Map<string, string>();
    const declaring = new Set(readOperations(committed).operations.filter((operation) => operation.entitlement !== undefined).map((operation) => operation.operationId));
    for (const { operationId, kind, policy } of classifyOperations(committed).operations) {
      if (kind === "tenant-scoped") {
        // Its owner, and the principal just below the policy: a member of a workspace of its own below `admin`, an account with no workspace below `member`.
        const email = `walker-${operationId}@example.test`.toLowerCase();
        cookies.set(operationId, await signIn(email, needsReauth.has(operationId), false, "owner"));
        if (writing.has(operationId) && lastOwned.current !== undefined) {
          readOnlyTokens.set(operationId, (await seedApiToken(database(), { ...lastOwned.current, scope: "read" })).value);
        }
        if (needsReauth.has(operationId)) {
          // An owner of a workspace of its own that has not re-authenticated: the policy admits it, the re-authentication does not.
          stale.set(operationId, await signIn(`walker-${operationId}-stale@example.test`.toLowerCase(), false, false, "owner"));
        }
        below.set(operationId, await signIn(`walker-${operationId}-below@example.test`.toLowerCase(), false, false, policy === "member" ? undefined : "member"));
        if (declaring.has(operationId)) {
          // An owner of a workspace of its own whose account the entitlement source does not hold the entitlement for: the policy admits it, the entitlement does not.
          without.set(operationId, await signIn(`walker-${operationId}-unentitled@example.test`.toLowerCase(), false, false, "owner", false));
        }
        continue;
      }
      if (kind === "process" && policy === "instanceAdmin") {
        // An instance admin with a second factor, and the account just below the policy: an ordinary one.
        cookies.set(operationId, await signIn(`walker-${operationId}@example.test`.toLowerCase(), needsReauth.has(operationId), false, undefined, true, true));
        if (needsReauth.has(operationId)) {
          // An instance admin with a second factor that has not re-authenticated: the policy admits it, the re-authentication does not.
          stale.set(operationId, await signIn(`walker-${operationId}-stale@example.test`.toLowerCase(), false, false, undefined, true, true));
        }
        below.set(operationId, await signIn(`walker-${operationId}-below@example.test`.toLowerCase(), false));
        continue;
      }
      if (kind !== "account-level") {
        continue;
      }
      const email = `walker-${operationId}@example.test`.toLowerCase();
      cookies.set(operationId, await signIn(email, needsReauth.has(operationId), operationId === "createApiToken" || operationId === "setActiveWorkspace"));
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
      tooLowRole: ({ operationId }) => credentialsOf(below, operationId),
      withoutEntitlement: ({ operationId }) => credentialsOf(without, operationId),
      readOnlyToken: ({ operationId }) => {
        const token = readOnlyTokens.get(operationId);
        if (token === undefined) {
          throw new Error(`the walker holds no read-only token for ${operationId}`);
        }
        return { headers: { authorization: `Bearer ${token}` } };
      },
      // The owner of the walker's own workspace names a member of workspace B, which it does not act in.
      workspaceA: ({ operationId }) => credentialsOf(cookies, operationId),
    };
  }

  // Each session the walker holds is a real sign-in with the production password hash, so the walk grows with every account-level operation.
  it("calls every operation of openapi.json and finds it as declared", async () => {
    const operations = classifyOperations(committed).operations;
    expect(Object.keys(FIXTURES).sort()).toEqual(operations.map((operation) => operation.operationId).sort());

    const unentitled = new Set<string>();
    const server = serve([], undefined, { memberships: true, entitlements: entitlementsExcept(unentitled) });
    const hooks = await sessionHooks(server, unentitled);
    const report = await walkContract({ document: committed, send: (request) => server.fetch(request), origin, fixtures: FIXTURES, hooks });
    // The walker holds the team it names for workspace B to the 404 it expects for an identifier of another workspace. A team is refused with 422
    // whichever workspace holds it, because no team can be invited into yet and none can be told from another, which discloses nothing. That answer
    // is the one difference of the walk, and the exception names exactly it (the status and the code that come with it).
    // The boolean filter `hasSlug` of the bookmark list is picked as an input that can carry an identifier by its name, and the identifier the walk
    // puts in it is refused as a malformed value (422) before any bookmark is looked at, which is the other difference.
    // The select-all takes the same filter and has the same difference. The bulk request is the third: it acts on the caller's own bookmarks and skips an identifier
    // of workspace B as not found without saying so (doc 02 section 5.8), so it answers 200 with the identifier counted as skipped instead of the 404 the walker expects.
    const teamRefusal = (failure: ContractFailure): boolean =>
      (failure.subject === "createInvitation (POST /api/v1/invitations), resource of workspace B" ||
        failure.subject === "listBookmarks (GET /api/v1/bookmarks), resource of workspace B" ||
        failure.subject === "listBookmarkIds (GET /api/v1/bookmarks/ids), resource of workspace B") &&
      (failure.detail === "answered 422, expected 404" || failure.detail === 'the problem code is "validation_failed", expected not_found');
    const skippedNotRefused = (failure: ContractFailure): boolean =>
      failure.subject === "bulkBookmarks (POST /api/v1/bookmarks/bulk), resource of workspace B" &&
      (failure.detail === "answered 200, expected 404" || failure.detail === "the problem code is undefined, expected not_found");
    expect(report.failures.filter(teamRefusal).map((failure) => failure.kind)).toEqual(["unexpected_status", "wrong_code", "unexpected_status", "wrong_code", "unexpected_status", "wrong_code"]);
    expect(report.failures.filter(skippedNotRefused).map((failure) => failure.kind)).toEqual(["unexpected_status", "wrong_code"]);
    expect(report.failures.filter((failure) => !teamRefusal(failure) && !skippedNotRefused(failure))).toEqual([]);
    expect(report.operations).toBe(operations.length);
    expect(report.operations).toBeGreaterThan(0);
    // One valid request for each operation. Each of the eighty-three that need a session also answers 401 without one, each of the seventeen that declare
    // re-authentication answers 401 reauth_required without it, and each of the fifty-nine whose policy has a role below it (the thirty-two of a member, the ten
    // of an admin, the two of an owner and the fifteen of the instance admin) answers the principal just below it (404 below member, 403 below the others).
    // Each of the eighteen that declare the write scope answers 403 token_scope to a token that may only read, each of the four that declare an entitlement answers
    // 403 to an account without it, and each of the twenty-nine that name a member, a recipient, a team, an invitation, a bookmark, a slug, a tag or a folder, or an input that can carry one, answers for one of workspace B.
    expect(report.calls).toBe(operations.length + 83 + 17 + 59 + 18 + 4 + 29);
  }, WALK_TIMEOUT_MS);
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
    // the three sessions and the six tokens (a read and a read-write one of each role) of A against the two rows of B, on each of the three
    // operations that take a row; once on the three that take none
    expect(report.attempts).toBe(9 * 6 + 9 * 3);
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
    // every session and every token of A reaches the handler, which answers 200 for the row of B
    expect(report.failures.filter((failure) => failure.kind === "unexpected_status")).toHaveLength(9 * 2);
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
    // the member, by session or by token, is refused by stage 9 before the handler runs; the admin and the owner reach it
    const unexpected = report.failures.filter((failure) => failure.kind === "unexpected_status");
    expect(unexpected).toHaveLength((2 + 4) * 2);
    expect(unexpected.every((failure) => /^as (admin|owner) of A/.test(failure.detail))).toBe(true);
  });
});

describe("the cross-tenant matrix in API mode over the operations of the committed document", () => {
  // The tenant-scoped operations of the committed document act in the workspace of the request. Those on /workspace and the members list take no
  // identifier, so the matrix has none of workspace B to put in them: it makes each call as every principal of workspace A, reads and changes A's
  // workspace and settings, and holds that nothing of B is quoted in an answer. The role change and the removal name a member by account identifier and
  // the removal and the leaving may name a recipient, so the matrix puts each member of B in each and holds that A's principals are answered 404
  // (403 below the admin policy, and for a token). The invitation operations name an invitation of B by identifier, which is a real pending one
  // that the seed writes. In both, B's rows, its settings, its members, its invitations and its audit events are as they were.
  async function contentOfB(): Promise<string> {
    const rows = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ digest: string }[]>`
        SELECT md5(
          coalesce((SELECT string_agg(w::text, '|') FROM workspaces w WHERE w.id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(s::text, '|') FROM workspace_settings s WHERE s.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(m::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(e::text, '|' ORDER BY e.id) FROM audit_events e WHERE e.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(i::text, '|' ORDER BY i.id) FROM workspace_invitations i WHERE i.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(k::text, '|' ORDER BY k.id) FROM bookmarks k WHERE k.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM tags t WHERE t.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(l::text, '|' ORDER BY l.bookmark_id, l.tag_id) FROM bookmark_tags l WHERE l.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(f::text, '|' ORDER BY f.id) FROM folders f WHERE f.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(g::text, '|' ORDER BY g.folder_id, g.bookmark_id) FROM folder_bookmarks g WHERE g.workspace_id = ${probe.fixture.b.id}), '') ||
          coalesce((SELECT string_agg(q::text, '|' ORDER BY q.account_id, q.slug) FROM slug_preferences q WHERE q.workspace_id = ${probe.fixture.b.id}), '')
        ) AS digest`;
    });
    return rows[0]?.digest ?? "";
  }

  // The probe fixture names two workspaces and their members without creating them, so the rows the operations read and change are made here:
  // the accounts, the workspaces under the fixture's identifiers, each member with the role of its principal, and the settings rows.
  async function seedFixtureWorkspaces(): Promise<void> {
    const bookmarkIds = probe.fixture.b.identifiers.filter((identifier) => identifier.kind === "bookmark");
    const firstBookmark = bookmarkIds[0]?.id;
    // One transaction: the accounts first, each under its own account context, then everything else as the system role.
    await database().owner.begin(async (tx) => {
      for (const [side, workspace] of [["a", probe.fixture.a], ["b", probe.fixture.b]] as const) {
        for (const member of [workspace.owner, workspace.admin, workspace.member]) {
          await tx`SELECT set_config('app.account_id', ${member.accountId}, true)`;
          await tx`INSERT INTO accounts (id, email, display_name) VALUES (${member.accountId}, ${`matrix-${side}-${member.role}@example.test`}, ${`Matrix ${side} ${member.role}`})`;
        }
      }
      await tx`SET LOCAL ROLE slugbase_system`;
      for (const [side, workspace] of [["a", probe.fixture.a], ["b", probe.fixture.b]] as const) {
        await tx`INSERT INTO workspaces (id, name) VALUES (${workspace.id}, ${`Matrix workspace ${side.toUpperCase()}`})`;
        await tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspace.id})`;
        for (const member of [workspace.owner, workspace.admin, workspace.member]) {
          await tx`INSERT INTO workspace_members (workspace_id, account_id, role) VALUES (${workspace.id}, ${member.accountId}, ${member.role})`;
        }
      }
      // One pending invitation of workspace B, which the matrix names in the invitation operations of A.
      await tx`
        INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at)
        VALUES (${B_INVITATION_ID}, ${probe.fixture.b.id}, 'matrix-b-invitee@example.test', 'member', sha256('matrix-b-invitation'::bytea), now() + interval '7 days')`;
      // The two bookmarks of workspace B the fixture names, owned by its members: the matrix puts their identifiers in the path of the bookmark read.
      for (const [index, { id }] of bookmarkIds.entries()) {
        await tx`
          INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding)
          VALUES (${id}, ${probe.fixture.b.id}, ${[probe.fixture.b.owner, probe.fixture.b.member][index % 2]?.accountId ?? null}, 'https://example.com/matrix-b', 'https://example.com/matrix-b', 'example.com', ${`matrix-bookmark-of-b-${String(index)}`}, ${B_SLUGS.at(index) ?? null}, true)`;
      }
      // The owner of B remembers the first of them for its slug: a preference of workspace B that the matrix must neither read nor change.
      if (firstBookmark !== undefined) {
        await tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${probe.fixture.b.id}, ${probe.fixture.b.owner.accountId}, ${B_SLUGS[0]}, ${firstBookmark})`;
      }
      // The tag of workspace B the fixture names, owned by its owner, linked to the first bookmark of B: the matrix puts its identifier in the path of the rename and of the deletion.
      for (const { id } of probe.fixture.b.identifiers.filter((identifier) => identifier.kind === "tag")) {
        await tx`INSERT INTO tags (id, workspace_id, owner_id, name) VALUES (${id}, ${probe.fixture.b.id}, ${probe.fixture.b.owner.accountId}, 'matrix-tag-of-b')`;
        if (firstBookmark !== undefined) {
          await tx`INSERT INTO bookmark_tags (workspace_id, bookmark_id, tag_id) VALUES (${probe.fixture.b.id}, ${firstBookmark}, ${id})`;
        }
      }
      // The folder of workspace B the fixture names, owned by its owner, with the first bookmark of B filed in it: the matrix puts its identifier in the path of the read, the change and the deletion.
      for (const { id } of probe.fixture.b.identifiers.filter((identifier) => identifier.kind === "folder")) {
        await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${id}, ${probe.fixture.b.id}, ${probe.fixture.b.owner.accountId}, 'matrix-folder-of-b')`;
        if (firstBookmark !== undefined) {
          await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${probe.fixture.b.id}, ${id}, ${firstBookmark})`;
        }
      }
    });
  }

  it("passes for the forty-four tenant-scoped operations, and leaves workspace B, its settings, its members, its invitations, its bookmarks, its tags, its folders, its remembered choices and its audit log as they were", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    await seedFixtureWorkspaces();
    const before = await contentOfB();
    // The deletion of the workspace takes no identifier, so the matrix repeats it as every principal of A (the sessions of the matrix have just
    // re-authenticated): the guard of the composition refuses it, which keeps A in place for the calls that follow, and the refusal is what a
    // deployment with an active subscription answers.
    const server = serve([
      {
        name: "stub-principals",
        hooks: { deletionGuard: () => HookResult.refuse("billing_active") },
        hookRefusals: { deletionGuard: ["billing_active"] },
        register: () => ({ routes: [], authenticators: world.authenticators }),
      },
    ], undefined, { entitlements: entitlementsExcept(new Set()) });
    // The fixture of the probe holds no team, so workspace B is given one: the matrix puts it in the invitation's `teamIds`. It holds no invitation
    // either, and is given the one the seed wrote.
    // The instance admin of the stub world belongs to neither workspace; the matrix sends it every call as well.
    const fixture = {
      ...probe.fixture,
      b: {
        ...probe.fixture.b,
        identifiers: [...probe.fixture.b.identifiers, { kind: "team" as const, id: UNKNOWN_TEAM_ID }, { kind: "invitation" as const, id: B_INVITATION_ID }, ...B_SLUGS.map((id) => ({ kind: "slug" as const, id }))],
      },
      instanceAdmin: PROBE_INSTANCE_ADMIN,
    };

    const send = matrixRequest({ send: (request) => server.fetch(request), origin, fixtures: FIXTURES, credentialsOf: (principal) => world.credentialsOf(principal) });
    const byFilterFixtures: ContractFixtures = {
      ...FIXTURES,
      bulkBookmarks: { body: { action: "pin", filter: {} }, status: 200, foreign: { body: { action: "pin", filter: {} } } },
      previewBulkBookmarks: { body: { action: "add_tags", filter: {}, tagIds: [UNKNOWN_TAG_ID] }, status: 404, foreign: { body: { action: "add_tags", filter: {}, tagIds: [UNKNOWN_TAG_ID] } } },
    };
    const sendByFilter = matrixRequest({ send: (request) => server.fetch(request), origin, fixtures: byFilterFixtures, credentialsOf: (principal) => world.credentialsOf(principal) });
    const variants: VariantStatuses[] = [];
    const instanceAdminStatuses: number[] = [];
    const resolutions: unknown[] = [];
    const searches: unknown[] = [];
    const mapping = { rowId: "bookmark", accountId: "member", transferTo: "member", "teamIds[]": "team", id: "invitation", "getBookmark.id": "bookmark", "createBookmark.slug": "bookmark", "updateBookmark.slug": "bookmark", "checkSlugAvailability.slug": "bookmark", "checkSlugAvailability.bookmarkId": "bookmark", "resolveSlug.slug": "slug", "chooseSlug.slug": "slug", "chooseSlug.bookmarkId": "bookmark", "deleteGoPreference.slug": "slug", "updateBookmark.id": "bookmark", "deleteBookmark.id": "bookmark", "openBookmark.id": "bookmark", "renameTag.id": "tag", "deleteTag.id": "tag", "mergeTag.id": "tag", "mergeTag.intoTagId": "tag", "getFolder.id": "folder", "updateFolder.id": "folder", "deleteFolder.id": "folder", "addFolderBookmarks.id": "folder", "removeFolderBookmarks.id": "folder", "addFolderBookmarks.bookmarkIds[]": "bookmark", "removeFolderBookmarks.bookmarkIds[]": "bookmark", "listBookmarks.folderId": "folder", "createBookmark.folderIds[]": "folder", "updateBookmark.folderIds[]": "folder", "listBookmarks.tag": "tag", "listBookmarks.tag[]": "tag", "createBookmark.tagIds[]": "tag", "updateBookmark.tagIds[]": "tag", "listBookmarks.hasSlug": "bookmark", "listBookmarkIds.hasSlug": "bookmark", "listBookmarkIds.folderId": "folder", "listBookmarkIds.tag": "tag", "listBookmarkIds.tag[]": "tag", "bulkBookmarks.ids[]": "bookmark", "bulkBookmarks.filter.hasSlug": "bookmark", "bulkBookmarks.filter.folderId": "folder", "bulkBookmarks.filter.tag": "tag", "bulkBookmarks.filter.tag[]": "tag", "bulkBookmarks.folderId": "folder", "bulkBookmarks.tagIds[]": "tag", "previewBulkBookmarks.ids[]": "bookmark", "previewBulkBookmarks.filter.hasSlug": "bookmark", "previewBulkBookmarks.filter.folderId": "folder", "previewBulkBookmarks.filter.tag": "tag", "previewBulkBookmarks.filter.tag[]": "tag", "previewBulkBookmarks.tagIds[]": "tag" } as const;
    const request = async (call: ApiCall): Promise<ApiResponse> => {
      // The bulk request and the preview name the identifiers of B in several inputs, and one request cannot carry them all: `ids` and `filter` together are malformed, the
      // `hasSlug` of the filter is a boolean, and the folder and the tag go with different actions. Each call is therefore sent as the requests below, which reach the
      // handler with the identifiers of B in turn, and the one that names the folder (the preview: the tags) of B is the answer the matrix judges. The others are held to what the
      // handler answers for them in the assertions after the run.
      const operationId = call.operation.operationId;
      const response =
        operationId === "bulkBookmarks" || operationId === "previewBulkBookmarks" ? await sendVariants(call, send, sendByFilter, variants) : await send(call);
      if ("instanceAdmin" in call.principal) {
        instanceAdminStatuses.push(response.status);
      }
      if (operationId === "resolveSlug" && response.status === 200) {
        resolutions.push(response.body);
      }
      if (operationId === "search" && response.status === 200) {
        searches.push(response.body);
      }
      return response;
    };
    // The tenant-scoped operations are run as separate matrices over disjoint parts of the document, at the same time, because the runner makes its calls one after the other and each
    // waits on the database. The matrix judges a call by its status and by the names of B in its answer, which no operation's writes to A change, and each effect in A
    // that the assertions after the run read (the tags and folders each account makes, the renaming, the settings) is made by one operation, whose calls stay in order within its part. Every part has
    // the same fixture, principals and check of B's content.
    const classification = classifyOperations(committed);
    const tenantScoped = classification.operations.filter((operation) => operation.kind === "tenant-scoped").map((operation) => operation.operationId);
    const runs = await Promise.all(
      Array.from({ length: MATRIX_PARTS }, (_, part) =>
        runApiMatrix({ document: documentOf(new Set(tenantScoped.filter((_, index) => index % MATRIX_PARTS === part))), fixture, mapping, emptyAnswers: { resolveSlug: 200 }, request }),
      ),
    );
    const matrix = {
      classified: classification.summary,
      tenantScoped: runs.reduce((count, run) => count + run.classified.byKind["tenant-scoped"], 0),
      attempts: runs.reduce((count, run) => count + run.attempts, 0),
      failures: [...classification.problems.map((problem) => ({ mode: "api" as const, subject: problem.subject, kind: "unclassified_operation", detail: problem.detail })), ...runs.flatMap((run) => run.failures)],
    };

    // A team is refused with 422 whichever workspace holds it, because no team can be invited into yet and none can be told from another, which
    // discloses nothing; the matrix expects 404 for an identifier of workspace B. The exception names exactly that answer, for the two sessions of A
    // that reach the handler (the member and the tokens are refused with 403 before it, as the matrix expects).
    const refusedAs422 = (failure: MatrixFailure): boolean => failure.kind === "unexpected_status" && /answered 422, expected 404/.test(failure.detail);
    const teamRefusal = (failure: MatrixFailure): boolean => failure.subject.startsWith("createInvitation ") && refusedAs422(failure);
    // The boolean filter `hasSlug` of the bookmark list is picked as an input that can carry an identifier by its name. The identifier of workspace B that
    // the matrix puts in it is refused as a malformed query, 422, before any bookmark is looked at, for every principal that reaches the operation.
    // The select-all has the same `hasSlug` filter, and the bulk request skips an identifier of B as not found with a 200 (nothing is written and B's content is as it was).
    const filterRefusal = (failure: MatrixFailure): boolean => (failure.subject.startsWith("listBookmarks ") || failure.subject.startsWith("listBookmarkIds ")) && refusedAs422(failure);
    const report = { ...matrix, failures: matrix.failures.filter((failure) => !teamRefusal(failure) && !filterRefusal(failure)) };
    expect(matrix.failures.filter(teamRefusal).map((failure) => failure.detail.slice(0, "as owner of A".length))).toEqual(["as owner of A", "as admin of A"]);
    // Each of the ten principals, the instance admin among them, naming the two bookmarks of B once in the `hasSlug` of the list and once in that of the select-all.
    expect(matrix.failures.filter(filterRefusal)).toHaveLength(10 * 2 * 2);
    expect(report.failures).toEqual([]);
    expect(report.tenantScoped).toBe(44);
    expect(report.classified.byKind["tenant-scoped"]).toBe(44);
    // The bulk request reaches its handler as the three sessions and the three read-write tokens of A, once for each pair of the two bookmarks of B and of the two inputs the matrix fills in `ids` and
    // in the filter's `hasSlug`, and the preview of adding tags is called as the same ten principals. Where the bulk handler is reached, a bookmark of B named in `ids` is skipped as not found with a
    // 200 that reports nothing affected, a filter on the folder and the tags of B matches nothing, and a folder or a tag of B is the declared 404 whichever action names it. Where it is not (a token that
    // may only read, the instance admin) every request gets the one answer of the stage before the handler.
    const bulkCalls = variants.filter((variant) => variant.operation === "bulkBookmarks");
    const previewCalls = variants.filter((variant) => variant.operation === "previewBulkBookmarks");
    expect([bulkCalls.length, previewCalls.length]).toEqual([10 * 2 * 2, 10 * 2 * 2]);
    const reaching = bulkCalls.filter((variant) => variant.statuses.skippedById === 200);
    expect(reaching).toHaveLength(6 * 2 * 2);
    expect(reaching.map((variant) => [variant.statuses, variant.affectedById, variant.requestedByFilter])).toEqual(
      reaching.map(() => [{ skippedById: 200, folderOfB: 404, tagsOfB: 404, filterOfB: 200, filterAndFolderOfB: 404 }, 0, 0]),
    );
    for (const variant of [...bulkCalls.filter((candidate) => candidate.statuses.skippedById !== 200), ...previewCalls]) {
      expect(new Set(Object.values(variant.statuses)).size).toBe(1);
    }
    // the three sessions and the six tokens (a read and a read-write one of each role) of A, once on each of the nine operations that name no member
    // (the entitlements, the invitation list and the creation of a bookmark among them) and on the invitation, which names the one team of B,
    // and on the operations that name members of B once for each of them: the role change, and the leaving, which names a recipient, once for each
    // of the three, and the ownership transfer, which names the member who becomes an owner, once for each of the three; the removal names both
    // a member and a recipient, once for each pair; the resend, the link and the revocation of an invitation name the one invitation of B once each
    // The instance admin is a tenth principal making the same thirty calls, and each of them is answered 404 whatever the policy of the operation:
    // it holds no membership, so there is no workspace for a handler to act in or a role to be refused for.
    // The creation of a bookmark names each of the two bookmarks of B once in its `slug`, with the folder and the tag of B in the same request, and the change names each of the two in its path once for each of the two in its `slug`, and the slug availability each of the two in `bookmarkId` once for each of the two in `slug`: the `slug` is mapped to a bookmark, the identifier next to it is the one that is looked up and refused 404 first.
    // The bookmark read, deletion and open name each of the two bookmarks of B once each, and so do the bookmark list and the select-all in their `hasSlug` input (the list also names the one tag of B in `tag`, and that query is refused as a whole);
    // the bulk request, and its preview of adding tags, name each of the two in `ids` once for each of the two in `filter.hasSlug`.
    // The creation, the list and the statistics of tags and the creation and the list of folders name none, and the rename, the merge and the deletion of a tag and the read, the change and the deletion of a folder name the one tag or folder of B once each (the merge names it in the path and as the target, the one pair, which the handler answers 404 as it does any other since the tag is not the caller's).
    // The filing and the unfiling of bookmarks name the one folder of B in the path and each of the two bookmarks of B in the body, once for each of the two.
    // The resolution of a slug names each of the two slugs of B once, which the caller resolves to nothing with an empty 200 (the caller has no bookmark with it, and workspace B is not read for it), and the choice names each of the two slugs of B once for each of the two bookmarks that have them, the right pair among them, which is the declared 404 slug_not_found.
    // The search names none (one of the eighteen calls that name nothing): its text is the one the rows of B are named after.
    // The list of remembered choices names none (one of the seventeen calls that name nothing), and forgetting one names each of the two slugs of B once, the first of which the owner of B has a choice for, which is the declared 404 not_found and leaves it.
    const calls = 18 + (3 + 3 + 3 + 3 * 3 + 3) + 3 * 2 + 2 * 2 + 2 + 2 + 2 * 2 + 3 + 3 + 2 * 2 + 2 * 2 + 2 * 2 + 2 + 2 * 2 + 2;
    expect(report.attempts).toBe(10 * calls);
    // The four exceptions are the identifiers of B in the `hasSlug` filter of the bookmark list and of the select-all, which the query validation refuses before the instance admin's missing membership is looked at.
    expect(instanceAdminStatuses.toSorted()).toEqual([...Array<number>(calls - 4).fill(404), 422, 422, 422, 422]);
    // Each of the two slugs of B resolved by the three sessions and the three read-write tokens of A (the other principals are refused before the handler) is none, and names
    // no other workspace: no member of A belongs to B, so B is not offered, and neither is its name or content.
    expect(resolutions).toEqual(Array.from({ length: 6 * 2 }, () => ({ result: "none", otherWorkspaces: [] })));
    // Each of the three sessions and the six tokens of A (a token that may only read can search) searched for the text that every row of B is named after: no bookmark, folder or tag of B comes
    // back, and neither does the slug of one, while the matrix of A holds nothing that matches.
    expect(searches).toEqual(Array.from({ length: 9 }, () => ({ bookmarks: [], folders: [], tags: [] })));
    expect(await contentOfB()).toBe(before);
    // Every invitation the matrix tried to make was refused before anything was written, in A as in B, and the one invitation of B is still its own,
    // pending, with the token hash the seed gave it.
    const written = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ workspace_id: string; id: string; status: string }[]>`SELECT workspace_id, id, status FROM workspace_invitations WHERE workspace_id IN (${probe.fixture.a.id}, ${probe.fixture.b.id})`;
    });
    expect(written.map((row) => [row.workspace_id, row.id, row.status])).toEqual([[probe.fixture.b.id, B_INVITATION_ID, "pending"]]);
    // The requests reached the handlers: the sessions of A renamed A and turned its AI suggestions off, and the tokens changed nothing of the workspace.
    const [changed] = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ name: string; ai_enabled: boolean; actions: string[] }[]>`
        SELECT w.name, s.ai_enabled, (SELECT array_agg(DISTINCT e.action ORDER BY e.action) FROM audit_events e WHERE e.workspace_id = w.id) AS actions
        FROM workspaces w JOIN workspace_settings s ON s.workspace_id = w.id WHERE w.id = ${probe.fixture.a.id}`;
    });
    expect(changed).toEqual({ name: "Walker's renamed workspace", ai_enabled: false, actions: ["workspace.renamed", "workspace.settings_changed"] });
    // The creation of a bookmark reached its handler for the three sessions and the three tokens that may write, and each of them named the folder of B in `folderIds` and the tag of B in `tagIds`:
    // the creation was refused with 404 before anything was written, so the counter of A was never taken, no bookmark of A exists and the two of B are untouched. (A token that
    // may only read was refused before the handler.)
    const bookmarks = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ counter: number; created: string }[]>`
        SELECT (SELECT bookmark_count FROM workspaces WHERE id = ${probe.fixture.a.id}) AS counter, count(*)::text AS created
        FROM bookmarks WHERE workspace_id = ${probe.fixture.a.id}`;
    });
    const principalsOfA = [probe.fixture.a.owner, probe.fixture.a.admin, probe.fixture.a.member].map((principal) => principal.accountId).sort();
    expect(bookmarks).toEqual([{ counter: 0, created: "0" }]);
    // The creation of a tag reached its handler for the same sessions and tokens: every account of A made the tag, the second creation by an account (its session
    // and its token send one name) was refused as a name that is taken, a read-only token was refused before the handler, and the one tag of B is untouched.
    const tagsOfA = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ owner_id: string; name: string }[]>`SELECT owner_id, name FROM tags WHERE workspace_id = ${probe.fixture.a.id} ORDER BY owner_id`;
    });
    expect(tagsOfA.map((row) => [row.owner_id, row.name])).toEqual(principalsOfA.map((accountId) => [accountId, "Walker tag"]));
    // The creation of a folder reached its handler the same way, each account of A made the folder and the one folder of B is untouched.
    const foldersOfA = await database().owner.begin(async (tx) => {
      await tx`SET LOCAL ROLE slugbase_system`;
      return tx<{ owner_id: string; name: string }[]>`SELECT owner_id, name FROM folders WHERE workspace_id = ${probe.fixture.a.id} ORDER BY owner_id`;
    });
    expect(foldersOfA.map((row) => [row.owner_id, row.name])).toEqual(principalsOfA.map((accountId) => [accountId, "Walker folder"]));
  });
});

describe("the token-exclusion matrix over the server", () => {
  const document = buildDocument(probeOperations, committed);

  it("passes for the chain: a token never calls the instance operation, a read token no write, and the others answer as their handlers do", async () => {
    const server = serve([probeModule(probe, world)], document);
    const report = await runTokenMatrix({
      document,
      request: tokenMatrixRequest({ send: (request) => server.fetch(request), origin, fixtures: probeFixtures(probe), credentialsOf: (scope) => world.tokenOf(scope) }),
    });
    expect(report.failures).toEqual([]);
    expect(report.classified.total).toBe(probeOperations.length);
    // getProbeInstance declares no scope; checkProbeRow is the one write; the other six are reads
    expect(report).toMatchObject({ refused: 1, scoped: 1, readable: 6, unaffected: 0 });
    expect(report.attempts).toBe(probeOperations.length * 2);
  });

  it("calls an operation with no fixture, with placeholder identifiers: the refusal of a token does not look at the row", async () => {
    const server = serve([probeModule(probe, world)], document);
    const report = await runTokenMatrix({
      document,
      request: tokenMatrixRequest({ send: (request) => server.fetch(request), origin, fixtures: {}, credentialsOf: (scope) => world.tokenOf(scope) }),
    });
    // The one a token may not call is refused as declared with no fixture. The one that declares the write scope needs its body to get
    // past validation, so a read token is answered 422 there, before the scope: the failure names what the fixture has to add.
    expect(report.refused).toBe(1);
    expect(report.failures.map((failure) => [failure.kind, failure.subject])).toEqual([["scope_not_enforced", expect.stringContaining("checkProbeRow") as string]]);
  });
});
