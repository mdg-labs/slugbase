import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HOOK_TIMEOUT_MS, send, workspaceHarness, type World } from "../workspaces/support.ts";
import { signInAdmin, type Principal } from "./support.ts";

// The instance always keeps an enabled instance admin (doc 02 section 11.2, doc 05 section 7.1, doc 10 T3), whichever way
// requests arrive: the demotion and the disabling through PATCH /instance/accounts/{id}, the deletion through
// DELETE /instance/accounts/{id}, and the owner's own deletion through DELETE /me. The sequential refusals are
// decided at the HTTP surface here; the interleavings that decide the repositories' lock are driven deterministically
// in packages/db/test/instance-accounts.integration.test.ts ("changes to the set of admins that race": two demotions,
// a disabling against a demotion, two demotions the other way round, and a deletion against a demotion) and in
// packages/db/test/instance-account-deletion.integration.test.ts ("the last instance admin": a deletion against a
// demotion, a self-deletion, and the lock the deletions take). The suite here relies on them for the exact
// interleavings and adds what only the whole stack can show: two admins whose requests arrive together through the chain
// can never both succeed in removing each other, or themselves.

const ACCOUNTS = "/api/v1/instance/accounts";

const database = useTestDatabase();
const harness = workspaceHarness(database);
let world: World;

beforeAll(async () => {
  await harness.start();
  world = harness.serve();
}, HOOK_TIMEOUT_MS);
afterAll(() => harness.stop());

beforeEach(async () => {
  await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET is_instance_admin = false WHERE is_instance_admin`;
  });
});

async function enabledAdmins(): Promise<number> {
  const rows = await database().owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE is_instance_admin AND disabled_at IS NULL`;
  });
  return rows[0]?.count ?? 0;
}

/** Two admins, the only ones the instance has. */
async function pair(): Promise<[Principal, Principal]> {
  return [await signInAdmin(database(), world), await signInAdmin(database(), world)];
}

type Kind = "demote" | "disable" | "delete";

function removal(actor: Principal, victim: Principal, kind: Kind): { method: string; path: string; body?: unknown } {
  const self = actor.accountId === victim.accountId;
  if (kind === "delete") {
    return self
      ? { method: "DELETE", path: "/api/v1/me", body: { email: actor.email } }
      : { method: "DELETE", path: `${ACCOUNTS}/${victim.accountId}` };
  }
  return {
    method: "PATCH",
    path: `${ACCOUNTS}/${victim.accountId}`,
    body: kind === "demote" ? { isInstanceAdmin: false } : { disabled: true },
  };
}

function act(actor: Principal, victim: Principal, kind: Kind): Promise<Response> {
  const { method, path, body } = removal(actor, victim, kind);
  return send(world, method, path, { cookie: actor.cookie }, body);
}

const KINDS: readonly Kind[] = ["demote", "disable", "delete"];

describe("the only enabled instance admin", () => {
  it.each([
    ["demoting themselves", "demote"],
    ["disabling themselves", "disable"],
    ["deleting their own account through DELETE /me", "delete"],
  ] as const)("is refused 422 validation_failed %s, and stays an enabled admin", async (_name, kind) => {
    const only = await signInAdmin(database(), world);
    expect(await enabledAdmins()).toBe(1);

    const response = await act(only, only, kind);

    expect(response.status).toBe(422);
    expect(await enabledAdmins()).toBe(1);
  });

  it("is refused when the other admin is disabled: a disabled admin is not an admin the instance can fall back on", async () => {
    const [first, second] = await pair();
    expect((await act(first, second, "disable")).status).toBe(200);
    expect(await enabledAdmins()).toBe(1);

    for (const kind of KINDS) {
      const response = await act(first, first, kind);
      expect([kind, response.status]).toEqual([kind, 422]);
    }
    expect(await enabledAdmins()).toBe(1);
  });

  it("cannot be deleted through DELETE /instance/accounts/{id} by themselves: that route refuses an admin's own account", async () => {
    const first = await signInAdmin(database(), world);
    const response = await send(world, "DELETE", `${ACCOUNTS}/${first.accountId}`, { cookie: first.cookie });
    expect(response.status).toBe(422);
    expect(await enabledAdmins()).toBe(1);
  });
});

describe("two admins whose requests arrive together", () => {
  // Every pair of the requests that remove an admin from the enabled ones, aimed so that together they would remove both: each removes the
  // other, or each removes itself. The two admins are interchangeable, so a pair of kinds is run once. Both requests start in one tick, so
  // which of them reaches the database first is for the database to decide; the exact interleavings are the ones the repository suites drive.
  const cases = KINDS.flatMap((first, index) => KINDS.slice(index).map((second) => ({ first, second })));

  async function race(aim: "the other" | "itself", first: Kind, second: Kind): Promise<void> {
    const [x, y] = await pair();
    const [fromX, fromY] = await Promise.all(aim === "itself" ? [act(x, x, first), act(y, y, second)] : [act(x, y, first), act(y, x, second)]);

    const statuses = [fromX.status, fromY.status];
    const succeeded = statuses.filter((status) => status >= 200 && status < 300);
    expect(succeeded, `answers: ${statuses.join(", ")}`).toHaveLength(1);
    // The request that lost changed nothing: it was refused, by the last-admin rule (422) or because the winner had already taken its caller's standing away.
    expect(statuses.filter((status) => status < 200 || status >= 300).every((status) => status >= 400)).toBe(true);
    expect(await enabledAdmins()).toBe(1);
  }

  it.each(cases)("never leaves the instance without an enabled admin when each removes the other, by $first and by $second", ({ first, second }) => race("the other", first, second));

  it.each(cases)("never leaves the instance without an enabled admin when each removes itself, by $first and by $second", ({ first, second }) => race("itself", first, second));
});
