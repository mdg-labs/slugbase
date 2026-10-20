import {
  createEntitlementCheck,
  createEntitlementService,
  unconfigured,
  type AccountEntitlementValues,
  type EntitlementSource,
} from "@slugbase/core";
import { entitlementRepository } from "@slugbase/db";
import { LimitedEntitlementSource } from "@slugbase/testing";
import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAccount, seedMembership, seedWorkspace } from "../auth/support.ts";
import { tenantDatabase } from "../contract/support.ts";
import { HOOK_TIMEOUT_MS, bearer, send, workspaceHarness, type World } from "../workspaces/support.ts";

// GET /api/v1/entitlements through the whole chain over the migrated database, with the entitlement engine behind
// stage 9 (doc 04 section 10.4, doc 01 sections 7.5 and 8.3, doc 10 T1 and T11). The failure scenarios: values
// that come from anywhere but the source, a set that outlives a version change, a limit that applies on a
// deployment whose source limits nothing, usage counted from another workspace, an account-scoped value that
// one account sees of another, and an unconfigured source that reads as a grant.

const ENTITLEMENTS = "/api/v1/entitlements";
const INVITATIONS = "/api/v1/invitations";

const database = useTestDatabase();
const harness = workspaceHarness(database);

beforeAll(() => harness.start(), HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

const FULL = {
  "bookmarks.max": "unlimited",
  "seats.max": "unlimited",
  "workspaces.ownMax": "unlimited",
  "ai.suggestions": true,
  "sharing.members": true,
  "sharing.teams": true,
  "members.invite": true,
  "teams.manage": true,
  "audit.log": true,
};

interface EntitlementsBody {
  readonly entitlements: Record<string, unknown>;
  readonly usage: Record<string, number>;
  readonly upgradeAvailable: boolean;
}

const bodyOf = async (response: Response): Promise<EntitlementsBody> => (await response.json()) as EntitlementsBody;
const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { code: string }).code;

async function setBookmarkCount(workspaceId: string, count: number): Promise<void> {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET bookmark_count = ${count} WHERE id = ${workspaceId}`;
  });
}

/** Raises the version of the workspace as a plan change does: through the repository, in a transaction of its own. */
async function bumpVersion(workspaceId: string, accountId: string): Promise<number | undefined> {
  return tenantDatabase(database()).withTenant({ accountId, workspaceId, requestId: "entitlements-suite" }, (tx) => entitlementRepository(tx).bump());
}

async function workspaceWith(world: World, roles: readonly ("owner" | "admin" | "member")[]) {
  const people = await Promise.all(roles.map(() => harness.person(world)));
  const workspace = await harness.workspaceOf(people.map((person, index) => ({ person, role: roles[index] ?? "member" })));
  return { ...workspace, people };
}

describe("GET /entitlements", () => {
  it("answers every entitlement the CE source grants, with the usage and no upgrade path", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource() });
    const { workspaceId, people } = await workspaceWith(world, ["owner", "member", "member"]);
    await setBookmarkCount(workspaceId, 12);

    const response = await send(world, "GET", ENTITLEMENTS, { cookie: people[1]?.cookie ?? "" });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      entitlements: FULL,
      usage: { "bookmarks.used": 12, "seats.used": 3, "workspaces.owned": 0 },
      upgradeAvailable: false,
    });
  });

  it("reports the values of the source and its upgrade path, whatever the edition", async () => {
    const source = new LimitedEntitlementSource().grant("bookmarks.max", 100).grant("seats.max", 5).grant("workspaces.ownMax", 1).deny("sharing.teams").offerUpgrade(true);
    const world = harness.serve({ entitlementSource: source });
    const { people } = await workspaceWith(world, ["owner"]);

    const response = await send(world, "GET", ENTITLEMENTS, { cookie: people[0]?.cookie ?? "" });

    expect(await response.json()).toMatchObject({
      entitlements: { ...FULL, "bookmarks.max": 100, "seats.max": 5, "workspaces.ownMax": 1, "sharing.teams": false },
      upgradeAvailable: true,
    });
  });

  it("counts the workspaces the caller owns and the members and bookmarks of the active one only", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource() });
    const first = await workspaceWith(world, ["owner", "member"]);
    const second = await workspaceWith(world, ["owner", "member", "member", "member"]);
    await setBookmarkCount(first.workspaceId, 3);
    await setBookmarkCount(second.workspaceId, 40);
    const owner = first.people[0];
    if (owner === undefined) {
      throw new Error("no owner");
    }
    await seedMembership(database(), { workspaceId: second.workspaceId, accountId: owner.account.id, role: "owner" });

    const response = await send(world, "GET", ENTITLEMENTS, { cookie: owner.cookie });

    expect((await bodyOf(response)).usage).toEqual({ "bookmarks.used": 3, "seats.used": 2, "workspaces.owned": 2 });
  });

  it("is open to a read-scope token and a read-write token, and answers the workspace the token is bound to", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource() });
    const { workspaceId, people } = await workspaceWith(world, ["member"]);
    const person = people[0];
    if (person === undefined) {
      throw new Error("no member");
    }
    await setBookmarkCount(workspaceId, 8);

    for (const scope of ["read", "read-write"] as const) {
      const response = await send(world, "GET", ENTITLEMENTS, bearer(await harness.token(workspaceId, person, scope)));
      expect(response.status, scope).toBe(200);
      expect((await bodyOf(response)).usage["bookmarks.used"], scope).toBe(8);
    }
  });

  it("is refused without a session, and is a 404 for an account that acts in no workspace", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource() });
    const lonely = await harness.person(world);

    expect((await send(world, "GET", ENTITLEMENTS, {})).status).toBe(401);
    const response = await send(world, "GET", ENTITLEMENTS, { cookie: lonely.cookie });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("answers an account its own account-scoped values, never another account's", async () => {
    const perAccount = new LimitedEntitlementSource();
    const source: EntitlementSource = {
      available: true,
      forWorkspace: (workspaceId) => perAccount.forWorkspace(workspaceId),
      forAccount: (accountId) => Promise.resolve<AccountEntitlementValues>({ "workspaces.ownMax": accountId.endsWith("1") ? 1 : 5 }),
    };
    const world = harness.serve({ entitlementSource: source });
    const { people } = await workspaceWith(world, ["owner", "member"]);
    const [one, two] = people;
    if (one === undefined || two === undefined) {
      throw new Error("no people");
    }
    const ownMax = async (cookie: string) => (await bodyOf(await send(world, "GET", ENTITLEMENTS, { cookie }))).entitlements["workspaces.ownMax"];

    const answers = [await ownMax(one.cookie), await ownMax(two.cookie), await ownMax(one.cookie)];

    const expected = (account: string) => (account.endsWith("1") ? 1 : 5);
    expect(answers).toEqual([expected(one.account.id), expected(two.account.id), expected(one.account.id)]);
  });

  it("is a 503 when the composition configured no entitlement source, never a grant", async () => {
    const world = harness.serve();
    const { people } = await workspaceWith(world, ["owner"]);

    const response = await send(world, "GET", ENTITLEMENTS, { cookie: people[0]?.cookie ?? "" });

    expect(response.status).toBe(503);
    expect(await codeOf(response)).toBe("unavailable");
  });
});

describe("an operation that declares an entitlement", () => {
  it("is reachable on a deployment whose source limits nothing", async () => {
    const world = harness.serve({ entitlementSource: new LimitedEntitlementSource() });
    const { people } = await workspaceWith(world, ["owner", "admin"]);

    const response = await send(world, "POST", INVITATIONS, { cookie: people[1]?.cookie ?? "" }, { email: "invited@example.test", role: "member" });

    expect(response.status).toBe(201);
  });

  it("is refused with entitlement_required when the source withholds it, from the next request after the version moved", async () => {
    const source = new LimitedEntitlementSource();
    const world = harness.serve({ entitlementSource: source });
    const { workspaceId, people } = await workspaceWith(world, ["owner", "admin"]);
    const [owner, admin] = people;
    if (owner === undefined || admin === undefined) {
      throw new Error("no people");
    }
    const invite = (email: string) => send(world, "POST", INVITATIONS, { cookie: admin.cookie }, { email, role: "member" });
    expect((await invite("first@example.test")).status).toBe(201);

    // The source now withholds the entitlement, but the workspace's version stands: the set read at that version is still the one served.
    source.deny("members.invite");
    expect((await invite("second@example.test")).status).toBe(201);
    expect(await bumpVersion(workspaceId, owner.account.id)).toBe(2);
    const refused = await invite("third@example.test");

    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("entitlement_required");
    // A grant takes effect the same way.
    source.grant("members.invite", true);
    await bumpVersion(workspaceId, owner.account.id);
    expect((await invite("fourth@example.test")).status).toBe(201);
    expect(source.reads.workspaces.filter((id) => id === workspaceId)).toHaveLength(3);
  });

  it("is refused with entitlement_required where the composition configured no source", async () => {
    const world = harness.serve();
    const { people } = await workspaceWith(world, ["owner", "admin"]);

    const response = await send(world, "POST", INVITATIONS, { cookie: people[1]?.cookie ?? "" }, { email: "invited@example.test", role: "member" });

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("entitlement_required");
  });

  it("answers an error, never a grant, when the source fails", async () => {
    const failing: EntitlementSource = { ...unconfigured().entitlements, available: true };
    const world = harness.serve({ entitlementSource: failing });
    const { people } = await workspaceWith(world, ["owner", "admin"]);

    const response = await send(world, "POST", INVITATIONS, { cookie: people[1]?.cookie ?? "" }, { email: "invited@example.test", role: "member" });

    expect(response.status).toBe(503);
  });
});

describe("the check over the engine", () => {
  it("reads nothing for a workspace the account cannot see", async () => {
    const source = new LimitedEntitlementSource();
    const check = createEntitlementCheck(
      createEntitlementService({
        source,
        versions: {
          read: ({ accountId, workspaceId }) =>
            tenantDatabase(database()).withTenant({ accountId, workspaceId, requestId: "entitlements-suite" }, (tx) => entitlementRepository(tx).version()),
        },
      }),
    );
    const owner = await seedAccount(database(), { emailVerified: true });
    const gone = "0192f3a0-eeee-7000-8000-00000000ffff";

    expect(await check("members.invite", { accountId: owner.id, workspaceId: gone }, {})).toBe(false);
    expect(source.reads.workspaces).toEqual([]);
  });

  it("holds no entitlement in an existing workspace the account is no member of", async () => {
    const source = new LimitedEntitlementSource();
    const check = createEntitlementCheck(
      createEntitlementService({
        source,
        versions: {
          read: ({ accountId, workspaceId }) =>
            tenantDatabase(database()).withTenant({ accountId, workspaceId, requestId: "entitlements-suite" }, (tx) => entitlementRepository(tx).version()),
        },
      }),
    );
    const owner = await seedAccount(database(), { emailVerified: true });
    const outsider = await seedAccount(database(), { emailVerified: true });
    const workspaceId = await seedWorkspace(database(), { name: "Not theirs" });
    await seedMembership(database(), { workspaceId, accountId: owner.id, role: "owner" });

    expect(await check("members.invite", { accountId: owner.id, workspaceId }, {})).toBe(true);
    expect(await check("members.invite", { accountId: outsider.id, workspaceId }, {})).toBe(false);
  });
});

