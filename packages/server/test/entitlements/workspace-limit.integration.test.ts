import { CREDENTIAL_TOKEN_TTL_SECONDS, generateCredentialToken, PortUnavailable, type AccountEntitlementValues, type EntitlementSource } from "@slugbase/core";
import { credentialTokenRepository } from "@slugbase/db";
import { InMemoryMail, LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/auth/uuidv7.ts";
import { issuedToken, postJson, seedAccount, seedMembership, seedWorkspace } from "../auth/support.ts";
import { tenantDatabase } from "../contract/support.ts";
import { HOOK_TIMEOUT_MS, send, WORKSPACES, workspaceHarness, type Person, type World } from "../workspaces/support.ts";

// T11 at the creation of a workspace (doc 01 section 7.5, doc 02 sections 2.2 and 3.2, doc 04 sections 3.2 and 10.4,
// doc 10 T11), through the whole chain over the migrated database: `createWorkspace` answers 422
// workspace_limit_reached at the account's `workspaces.ownMax` and writes nothing, two creations at the limit minus one
// make one, `listWorkspaces` reports `canCreate: false` there, and a registration or a verification of an account at the
// limit still succeeds and leaves the account without a workspace. The handler decides this entitlement, not stage 9.

const TEST_TIMEOUT_MS = 60_000;
const REGISTER = "/api/v1/auth/register";
const VERIFY = "/api/v1/auth/verify-email";
const PASSWORD = "the password the owner chose on verifying";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);

afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner`TRUNCATE accounts CASCADE`;
  await database().owner`TRUNCATE workspaces CASCADE`;
  await database().owner`TRUNCATE pgboss.job`;
});

const ceiling = (value: number | "unlimited", upgrade = false): LimitedEntitlementSource => {
  const source = new LimitedEntitlementSource().grant("workspaces.ownMax", value);
  return upgrade ? source.offerUpgrade(true) : source;
};

function serve(source: EntitlementSource, options: { readonly env?: Record<string, string>; readonly mail?: InMemoryMail } = {}): World {
  return harness.serve({
    entitlementSource: source,
    allowWorkspaceCreation: true,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.mail === undefined ? {} : { mail: options.mail }),
  });
}

const create = (world: World, as: Person, name: string) => send(world, "POST", WORKSPACES, { cookie: as.cookie }, { name });

interface Problem {
  readonly code: string;
  readonly status: number;
  readonly limit?: unknown;
  readonly used?: unknown;
  readonly upgradeAvailable?: unknown;
}

async function problemOf(response: Response): Promise<Problem> {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  return (await response.json()) as Problem;
}

async function canCreate(world: World, as: Person): Promise<boolean> {
  const response = await send(world, "GET", WORKSPACES, { cookie: as.cookie });
  expect(response.status).toBe(200);
  return ((await response.json()) as { canCreate: boolean }).canCreate;
}

interface Written {
  readonly workspaces: number;
  readonly audit: number;
  readonly jobs: number;
}

async function written(): Promise<Written> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<Omit<Written, "jobs">[]>`
      SELECT (SELECT count(*) FROM workspaces)::int AS workspaces,
             (SELECT count(*) FROM audit_events WHERE action = 'workspace.created')::int AS audit`;
  });
  const jobs = await database().owner<{ n: number }[]>`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'event.workspace.created'`;
  return { workspaces: rows[0]?.workspaces ?? -1, audit: rows[0]?.audit ?? -1, jobs: jobs[0]?.n ?? -1 };
}

async function ownedBy(accountId: string): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_members WHERE account_id = ${accountId} AND role = 'owner'`;
  });
  return rows[0]?.n ?? -1;
}

async function accountByEmail(email: string): Promise<{ id: string; verified: boolean } | undefined> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ id: string; verified: boolean }[]>`SELECT id, email_verified_at IS NOT NULL AS verified FROM accounts WHERE email = ${email}`;
  });
  return rows[0];
}

describe("createWorkspace at workspaces.ownMax", () => {
  it(
    "creates the workspace of an account below the limit and refuses the next one with 422 workspace_limit_reached, the limit, the usage and the upgrade flag, writing nothing",
    async () => {
      const world = serve(ceiling(1));
      const owner = await harness.person(world);

      const first = await create(world, owner, "First");
      expect(first.status).toBe(201);
      const before = await written();
      const second = await create(world, owner, "Second");

      expect(second.status).toBe(422);
      expect(await problemOf(second)).toMatchObject({ code: "workspace_limit_reached", status: 422, limit: 1, used: 1, upgradeAvailable: false });
      expect(await written()).toEqual(before);
      expect(await ownedBy(owner.account.id)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it("says whether the plan behind the account's workspaces has a better one to offer", async () => {
    const world = serve(ceiling(1, true));
    const owner = await harness.person(world);
    await create(world, owner, "First");

    const refused = await create(world, owner, "Second");

    expect(await problemOf(refused)).toMatchObject({ code: "workspace_limit_reached", limit: 1, used: 1, upgradeAvailable: true });
  }, TEST_TIMEOUT_MS);

  it("refuses every creation under a limit of zero, with no usage and no upgrade to offer an account that owns nothing", async () => {
    const world = serve(ceiling(0, true));
    const owner = await harness.person(world);

    const refused = await create(world, owner, "First");

    expect(refused.status).toBe(422);
    expect(await problemOf(refused)).toMatchObject({ code: "workspace_limit_reached", limit: 0, used: 0, upgradeAvailable: false });
    expect((await written()).workspaces).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("makes one workspace of two parallel creations at the limit minus one", async () => {
    const world = serve(ceiling(1));
    const owner = await harness.person(world);

    const answers = await Promise.all([create(world, owner, "Left"), create(world, owner, "Right")]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 422]);
    expect(await ownedBy(owner.account.id)).toBe(1);
    expect(await written()).toEqual({ workspaces: 1, audit: 1, jobs: 1 });
    const refused = answers.find((answer) => answer.status === 422);
    expect(await problemOf(refused ?? new Response())).toMatchObject({ code: "workspace_limit_reached", limit: 1, used: 1 });
  }, TEST_TIMEOUT_MS);

  it("counts the workspaces the account owns and not those it is only a member of", async () => {
    const world = serve(ceiling(1));
    const person = await harness.person(world);
    const other = await seedAccount(database(), { emailVerified: true });
    const joined = await seedWorkspace(database(), { name: "Joined" });
    await seedMembership(database(), { workspaceId: joined, accountId: other.id, role: "owner" });
    await seedMembership(database(), { workspaceId: joined, accountId: person.account.id, role: "admin" });

    expect((await create(world, person, "Mine")).status).toBe(201);
    expect((await create(world, person, "Too many")).status).toBe(422);
  }, TEST_TIMEOUT_MS);

  it("creates workspaces without end under an unlimited limit, as the Community Edition's source grants", async () => {
    const world = serve(ceiling("unlimited"));
    const owner = await harness.person(world);

    for (const name of ["One", "Two", "Three"]) {
      expect((await create(world, owner, name)).status).toBe(201);
    }
    expect(await ownedBy(owner.account.id)).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("is decided after the creation policy: a deployment that lets no account create workspaces answers 403 forbidden at the limit too", async () => {
    const world = harness.serve({ entitlementSource: ceiling(0) });
    const owner = await harness.person(world);

    const refused = await create(world, owner, "First");

    expect(refused.status).toBe(403);
    expect((await problemOf(refused)).code).toBe("forbidden");
  }, TEST_TIMEOUT_MS);

  it("answers 503 and writes nothing when the entitlement source cannot say how many workspaces the account may own", async () => {
    const source: EntitlementSource = {
      available: true,
      forWorkspace: () => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
      forAccount: (): Promise<AccountEntitlementValues> => Promise.reject(new PortUnavailable("entitlements", "unavailable")),
    };
    const world = serve(source);
    const owner = await harness.person(world);

    const refused = await create(world, owner, "First");

    expect(refused.status).toBe(503);
    expect((await written()).workspaces).toBe(0);
  }, TEST_TIMEOUT_MS);
});

describe("listWorkspaces at workspaces.ownMax", () => {
  it("reports canCreate false for an account at the limit, true below it and true when the limit is unlimited", async () => {
    const limited = serve(ceiling(1));
    const owner = await harness.person(limited);
    expect(await canCreate(limited, owner)).toBe(true);
    await create(limited, owner, "First");
    expect(await canCreate(limited, owner)).toBe(false);

    const unlimited = serve(ceiling("unlimited"));
    expect(await canCreate(unlimited, owner)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("reports canCreate false under a limit of zero", async () => {
    const world = serve(ceiling(0));
    const owner = await harness.person(world);

    expect(await canCreate(world, owner)).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe("the personal workspace at workspaces.ownMax", () => {
  it("is not made for a registration at the limit, which still succeeds and leaves an account that can sign in and sees no workspace", async () => {
    const world = serve(ceiling(0), { env: { PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "false", RATE_LIMIT_REGISTER_IP: "1000/hour" } });
    const email = "limit.register@example.test";

    const registered = await world.server.fetch(postJson(world.origin, REGISTER, { displayName: "Ada Lovelace", email, password: PASSWORD }));

    expect(registered.status).toBe(202);
    const account = await accountByEmail(email);
    expect(account).toBeDefined();
    expect(await ownedBy(account?.id ?? "")).toBe(0);
    expect(await written()).toEqual({ workspaces: 0, audit: 0, jobs: 0 });
    const signedIn = await world.server.fetch(postJson(world.origin, "/api/v1/auth/login", { email, password: PASSWORD, remember: false }));
    expect(signedIn.status).toBe(200);
    const token = issuedToken(signedIn);
    const listed = await world.server.fetch(new Request(new URL(WORKSPACES, world.origin), { headers: { cookie: `__Host-slugbase_session=${token ?? ""}` } }));
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("is made for a registration below the limit", async () => {
    const world = serve(ceiling(1), { env: { PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "false", RATE_LIMIT_REGISTER_IP: "1000/hour" } });
    const email = "below.register@example.test";

    const registered = await world.server.fetch(postJson(world.origin, REGISTER, { displayName: "Ada Lovelace", email, password: PASSWORD }));

    expect(registered.status).toBe(202);
    expect(await ownedBy((await accountByEmail(email))?.id ?? "")).toBe(1);
  }, TEST_TIMEOUT_MS);

  it("is not made for a verification at the limit, which still verifies the address and signs the account in", async () => {
    const mail = new InMemoryMail();
    const world = serve(ceiling(0), { mail, env: { PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true", RATE_LIMIT_REGISTER_IP: "1000/hour" } });
    const email = "limit.verify@example.test";
    const registered = await world.server.fetch(postJson(world.origin, REGISTER, { displayName: "Ada Lovelace", email, password: "the password the visitor registered with" }));
    expect(registered.status).toBe(202);
    const account = await accountByEmail(email);
    expect(account?.verified).toBe(false);
    const token = generateCredentialToken();
    const issued = await tenantDatabase(database()).withTenant({ accountId: account?.id ?? "", requestId: "workspace-limit-test" }, (tx) =>
      credentialTokenRepository(tx).issue({ id: uuidv7(), purpose: "email_verify", tokenHash: token.hash, targetEmail: null, ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS["email_verify"] }),
    );
    expect(issued).toBe(true);

    const verified = await world.server.fetch(postJson(world.origin, VERIFY, { token: token.value, password: PASSWORD }));

    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ next: "done" });
    expect(issuedToken(verified)).toBeDefined();
    expect((await accountByEmail(email))?.verified).toBe(true);
    expect(await ownedBy(account?.id ?? "")).toBe(0);
    expect(await written()).toEqual({ workspaces: 0, audit: 0, jobs: 0 });
  }, TEST_TIMEOUT_MS);

  it("is made for a verification below the limit", async () => {
    const mail = new InMemoryMail();
    const world = serve(ceiling(1), { mail, env: { PUBLIC_REGISTRATION: "true", EMAIL_VERIFICATION_REQUIRED: "true", RATE_LIMIT_REGISTER_IP: "1000/hour" } });
    const email = "below.verify@example.test";
    await world.server.fetch(postJson(world.origin, REGISTER, { displayName: "Ada Lovelace", email, password: "the password the visitor registered with" }));
    const account = await accountByEmail(email);
    const token = generateCredentialToken();
    await tenantDatabase(database()).withTenant({ accountId: account?.id ?? "", requestId: "workspace-limit-test" }, (tx) =>
      credentialTokenRepository(tx).issue({ id: uuidv7(), purpose: "email_verify", tokenHash: token.hash, targetEmail: null, ttlSeconds: CREDENTIAL_TOKEN_TTL_SECONDS["email_verify"] }),
    );

    const verified = await world.server.fetch(postJson(world.origin, VERIFY, { token: token.value, password: PASSWORD }));

    expect(verified.status).toBe(200);
    expect(await ownedBy(account?.id ?? "")).toBe(1);
  }, TEST_TIMEOUT_MS);
});
