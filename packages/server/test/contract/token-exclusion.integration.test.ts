import { randomBytes } from "node:crypto";
import { apiTokenRepository, type AuthStore } from "@slugbase/db";
import { classifyOperations, isTokenCallable, loadOpenApiDocument, runTokenMatrix, type TokenMatrixReport, type TokenRequestFunction, type TokenScope } from "@slugbase/testing/tenancy";
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
const MATRIX_PARTS = 4;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The document with only the operations named, each under its own path, and everything else of it (the components among them) as it is. */
function documentOf(document: unknown, operationIds: ReadonlySet<string>): unknown {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("the document has no paths");
  }
  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(document.paths)) {
    const kept = isRecord(item) ? Object.entries(item).filter(([, operation]) => isRecord(operation) && typeof operation.operationId === "string" && operationIds.has(operation.operationId)) : [];
    if (kept.length > 0) {
      paths[path] = Object.fromEntries(kept);
    }
  }
  return { ...document, paths };
}

/**
 * The token matrix over the document, run as separate matrices over disjoint parts of it at the same time: the runner makes its calls one after the other and each waits on the
 * database. The calls of one operation stay in order within its part, and the matrix judges each answer by its status and code alone. The parts' counts and failures are merged,
 * with the operations the classifier cannot place as the failures the runner reports for them.
 */
async function runTokenMatrixInParts(document: unknown, request: TokenRequestFunction): Promise<TokenMatrixReport> {
  const classification = classifyOperations(document);
  const operationIds = classification.operations.map((operation) => operation.operationId);
  const runs = await Promise.all(
    Array.from({ length: MATRIX_PARTS }, (_, part) =>
      runTokenMatrix({ document: documentOf(document, new Set(operationIds.filter((_, index) => index % MATRIX_PARTS === part))), request }),
    ),
  );
  return {
    classified: classification.summary,
    attempts: runs.reduce((count, run) => count + run.attempts, 0),
    refused: runs.reduce((count, run) => count + run.refused, 0),
    scoped: runs.reduce((count, run) => count + run.scoped, 0),
    readable: runs.reduce((count, run) => count + run.readable, 0),
    unaffected: runs.reduce((count, run) => count + run.unaffected, 0),
    failures: [
      ...classification.problems.map((problem) => ({ mode: "token" as const, subject: problem.subject, kind: "unclassified_operation", detail: problem.detail })),
      ...runs.flatMap((run) => run.failures),
    ],
  };
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
    // The session is made while the tokens are; the tokens are made one after the other, as the seeding helper names each after a counter it reads when its transaction runs.
    const [tokens, cookie] = await Promise.all([
      (async () => {
        const read = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId, scope: "read" });
        const write = await seedApiToken(database(), { accountId: alice.account.id, workspaceId: alice.workspaceId, scope: "read-write" });
        return { read: read.value, "read-write": write.value } satisfies Record<TokenScope, string>;
      })(),
      signIn(alice),
    ]);
    return { world, alice, cookie, tokens };
  }

  it("answers 403 forbidden to a token on every operation that declares no scope, and treats the others as declared", async () => {
    const { world, alice, tokens } = await scenario();
    const hashBefore = await store.passwordHashOf(alice.account.id);
    const sessionsBefore = (await store.listSessions(alice.account.id, null, 50)).map((session) => session.id);

    const report = await runTokenMatrixInParts(committed, requestFor(world, (scope) => ({ headers: bearer(tokens[scope]) })));
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
    const report = await runTokenMatrixInParts(committed, requestFor(world, (scope) => ({ headers: { ...bearer(tokens[scope]), cookie } })));
    expect(report.failures).toEqual([]);
    expect(report.refused).toBeGreaterThan(0);
  });

  it("fails an operation that is missing its auth declaration", async () => {
    const { world, tokens } = await scenario();
    const broken = structuredClone(committed) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const entry = broken.paths["/api/v1/me/sessions"]?.["get"];
    expect(entry).toBeDefined();
    delete entry?.["x-slugbase-auth"];
    const report = await runTokenMatrixInParts(broken, requestFor(world, (scope) => ({ headers: bearer(tokens[scope]) })));
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

    const sendWith = (value: string) => requestFor(world, () => ({ headers: { ...bearer(value), cookie } }));
    // The valid one first: the cookie and the token are good and the credential is what is being tested.
    const sendValid = sendWith(valid.value);
    await Promise.all(
      operations
        .filter((candidate) => isTokenCallable(candidate) && candidate.policy === "account")
        .map(async (operation) => {
          expect((await sendValid({ operation, scope: "read" })).status, operation.operationId).toBe(200);
        }),
    );

    // The four credentials are tried at the same time, as are the operations within each: each answer is judged by its status and code alone.
    const credentials = [["expired", expired.value], ["revoked", revoked.value], ["of a workspace the account left", wrongWorkspace.value], ["unknown", "slb_unknown"]] as const;
    const refusals = (
      await Promise.all(
        credentials.map(async ([label, value]) => {
          const send = sendWith(value);
          return Promise.all(
            operations.map(async (operation) => {
              const response = await send({ operation, scope: "read" });
              const code = typeof response.body === "object" && response.body !== null && "code" in response.body ? response.body.code : undefined;
              return response.status !== 401 || code !== "unauthenticated" ? `${operation.operationId} with a token ${label}: ${String(response.status)} ${String(code)}` : undefined;
            }),
          );
        }),
      )
    ).flat().filter((refusal) => refusal !== undefined);
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
