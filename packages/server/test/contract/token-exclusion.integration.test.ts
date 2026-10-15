import { randomBytes } from "node:crypto";
import { apiTokenRepository, type AuthStore } from "@slugbase/db";
import { classifyOperations, isTokenCallable, loadOpenApiDocument, runTokenMatrix, type TokenScope } from "@slugbase/testing/tenancy";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeMembership, seedAccount, seedApiToken, seedMembership, seedWorkspace, serveAuth, sha256, storeFor, type AuthWorld, type SeededAccount } from "../auth/support.ts";
import { FIXTURES, WALKER_ACCOUNT } from "./fixtures.ts";
import { tokenMatrixRequest } from "./matrix.ts";
import { tenantDatabase } from "./support.ts";
import type { Credentials } from "./walker.ts";

// The token-exclusion suite over the committed document and the server as
// composed (doc 08 section 3.3, doc 04 sections 1.2 and 4.2, doc 10 T3, T18 and
// 2.12): what a token principal can and cannot do is read from openapi.json, so
// an operation added to the contract is called here with no edit to this file,
// and one that lacks its auth declaration fails the suite. The tokens are real:
// minted through the repository, resolved by the authenticator of the server.
// The operations that need a workspace and a row of workspace B, and a write
// scope to refuse a read token, are in contract.integration.test.ts, over the
// test module that declares them.

const SESSION_COOKIE = "__Host-slugbase_session";

const database = useTestDatabase();
let store: AuthStore;

beforeAll(async () => {
  store = storeFor(database());
  // The anonymous sign-in operation is called with the walker's credentials, so it signs in with and without a token.
  await seedAccount(database(), WALKER_ACCOUNT);
});

afterAll(async () => {
  await store.close();
});

const committed = loadOpenApiDocument();
const operations = classifyOperations(committed).operations;

interface Holder {
  readonly account: SeededAccount;
  readonly workspaceId: string;
}

async function holder(): Promise<Holder> {
  const account = await seedAccount(database());
  const workspaceId = await seedWorkspace(database());
  await seedMembership(database(), { workspaceId, accountId: account.id, role: "owner" });
  return { account, workspaceId };
}

async function signIn(as: Holder): Promise<string> {
  const token = randomBytes(32);
  const created = await store.createSession({
    id: `0192f3a0-dddd-7000-8000-${randomBytes(6).toString("hex")}`,
    accountId: as.account.id,
    level: "full",
    remember: false,
    ipPrefix: null,
    userAgent: null,
    tokenHash: sha256(token),
    replacedTokenHash: null,
  });
  expect(created).toBe(true);
  return `${SESSION_COOKIE}=${token.toString("base64url")}`;
}

/** The request function of the token mode, sending the given credentials for the scope it is asked for. */
function requestFor(world: AuthWorld, credentialsOf: (scope: TokenScope) => Credentials) {
  return tokenMatrixRequest({ send: (request) => world.server.fetch(request), origin: world.origin, fixtures: FIXTURES, credentialsOf });
}

const bearer = (value: string): Credentials["headers"] => ({ authorization: `Bearer ${value}` });

async function expireToken(id: string): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${id}`;
  });
}

describe("a token principal over every operation of openapi.json", () => {
  /** Alice, a token of each scope and one session. */
  async function scenario() {
    const world = serveAuth(database(), store);
    const alice = await holder();
    const read = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId, scope: "read" });
    const write = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId, scope: "read-write" });
    const cookie = await signIn(alice);
    return { world, alice, cookie, tokens: { read: read.value, "read-write": write.value } satisfies Record<TokenScope, string> };
  }

  it("answers 403 forbidden to a token on every operation that declares no scope, and treats the others as declared", async () => {
    const { world, alice, tokens } = await scenario();
    const hashBefore = await store.passwordHashOf(alice.account.id);
    const sessionsBefore = (await store.listSessions(alice.account.id, null, 50)).map((session) => session.id);

    const report = await runTokenMatrix({ document: committed, request: requestFor(world, (scope) => ({ headers: bearer(tokens[scope]) })) });
    expect(report.failures).toEqual([]);
    expect(report.refused + report.scoped + report.readable + report.unaffected).toBe(operations.length);
    expect(report.refused).toBe(operations.filter((operation) => operation.policy !== "anonymous" && operation.policy !== "machine" && !isTokenCallable(operation)).length);
    // The contract has operations a token may not call, one it may and the operations outside the rules; none of this is vacuous.
    expect(report.refused).toBeGreaterThan(0);
    expect(report.readable).toBeGreaterThan(0);
    expect(report.unaffected).toBeGreaterThan(0);

    // The refusals changed nothing of the account.
    expect(await store.passwordHashOf(alice.account.id)).toBe(hashBefore);
    expect((await store.listSessions(alice.account.id, null, 50)).map((session) => session.id)).toEqual(sessionsBefore);
  });

  it("uses only the bearer when the request also carries a valid session cookie", async () => {
    const { world, tokens, cookie } = await scenario();
    // The cookie is the session of the same account: alone it would be let through by the operations a token is refused.
    const report = await runTokenMatrix({ document: committed, request: requestFor(world, (scope) => ({ headers: { ...bearer(tokens[scope]), cookie } })) });
    expect(report.failures).toEqual([]);
    expect(report.refused).toBeGreaterThan(0);
  });

  it("fails an operation that is missing its auth declaration", async () => {
    const { world, tokens } = await scenario();
    const broken = structuredClone(committed) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const entry = broken.paths["/api/v1/me/sessions"]?.["get"];
    expect(entry).toBeDefined();
    delete entry?.["x-slugbase-auth"];
    const report = await runTokenMatrix({ document: broken, request: requestFor(world, (scope) => ({ headers: bearer(tokens[scope]) })) });
    expect(report.failures.map((failure) => [failure.kind, failure.subject])).toEqual([["unclassified_operation", expect.stringContaining("listSessions") as string]]);
  });
});

describe("a token that is not valid", () => {
  // The token the account holds for a workspace it no longer belongs to is deleted with the membership; a token
  // for a workspace the account never belonged to cannot be made at all.
  it("answers 401 unauthenticated on every operation when it is expired, revoked, of a workspace the account left, or unknown, whatever cookie comes with it", async () => {
    const world = serveAuth(database(), store);
    const alice = await holder();
    const cookie = await signIn(alice);
    const left = await seedWorkspace(database());
    await seedMembership(database(), { workspaceId: left, accountId: alice.account.id, role: "member" });

    const expired = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId });
    const revoked = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId });
    const wrongWorkspace = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: left });
    const valid = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId });
    await expireToken(expired.id);
    await tenantDatabase(database()).withTenant({ accountId: alice.account.id, requestId: "token-exclusion" }, (tx) => apiTokenRepository(tx).revoke(revoked.id));
    await removeMembership(database(), left, alice.account.id);

    let current = valid.value;
    const send = requestFor(world, () => ({ headers: { ...bearer(current), cookie } }));
    // The valid one first: the cookie and the token are good and the credential is what is being tested.
    for (const operation of operations.filter((candidate) => isTokenCallable(candidate) && candidate.policy === "account")) {
      expect((await send({ operation, scope: "read" })).status, operation.operationId).toBe(200);
    }

    const refusals: string[] = [];
    for (const [label, value] of [["expired", expired.value], ["revoked", revoked.value], ["of a workspace the account left", wrongWorkspace.value], ["unknown", "slb_unknown"]] as const) {
      current = value;
      for (const operation of operations) {
        const response = await send({ operation, scope: "read" });
        const code = typeof response.body === "object" && response.body !== null && "code" in response.body ? response.body.code : undefined;
        if (response.status !== 401 || code !== "unauthenticated") {
          refusals.push(`${operation.operationId} with a token ${label}: ${String(response.status)} ${String(code)}`);
        }
      }
    }
    expect(refusals).toEqual([]);
  });

  it("cannot be made for a workspace the account is not a member of", async () => {
    const alice = await holder();
    const bob = await holder();
    const outcome = await tenantDatabase(database()).withTenant({ accountId: alice.account.id, requestId: "token-exclusion" }, (tx) =>
      apiTokenRepository(tx).create({
        id: "0192f3a0-aaaa-7000-8000-00000000ffff",
        workspaceId: bob.workspaceId,
        name: "borrowed",
        scope: "read-write",
        tokenHash: Buffer.alloc(32, 1),
        tokenPrefix: "slb_xxxx",
        expiresInDays: 90,
        limit: 10,
      }),
    );
    expect(outcome.kind).toBe("not_a_member");
  });
});
