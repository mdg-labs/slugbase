import { useTestDatabase } from "@slugbase/testing/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAccount } from "../auth/support.ts";
import { HOOK_TIMEOUT_MS, LEAVE, MEMBERS, TRANSFER, send, workspaceHarness, type Person, type World } from "./support.ts";

// Simultaneous demotions, removals, leaves and ownership transfers between two owners through the whole chain over
// the migrated database (doc 02 section 3.3, doc 05 section 2.2, doc 10 T1 and T2). The failure scenarios: a
// workspace left without an owner when the owners step down, remove one another or leave at the same moment, a
// call that answers 200 and has not changed what it says, a role or a membership that two calls corrupt between
// them, and an audit event that records a change that was not made or is missing for one that was.

const database = useTestDatabase();
const harness = workspaceHarness(database);

let world: World;

beforeAll(async () => {
  await harness.start();
  world = harness.serve();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness.stop();
});

const KINDS = ["demote", "remove", "leave", "transfer"] as const;
type Kind = (typeof KINDS)[number];

/** Which of the two owners asks, and for what: the owner asks about the other one, or about themselves for a leave. */
interface Attempt {
  readonly kind: Kind;
  readonly caller: 0 | 1;
}

interface Outcome extends Attempt {
  readonly status: number;
}

function call(kind: Kind, other: Person): { readonly method: string; readonly path: string; readonly body: unknown } {
  switch (kind) {
    case "demote":
      return { method: "PATCH", path: `${MEMBERS}/${other.account.id}`, body: { role: "admin" } };
    case "remove":
      return { method: "DELETE", path: `${MEMBERS}/${other.account.id}`, body: { content: "transfer" } };
    case "leave":
      return { method: "POST", path: LEAVE, body: { content: "transfer" } };
    case "transfer":
      return { method: "POST", path: TRANSFER, body: { accountId: other.account.id, demoteSelf: true } };
  }
}

/** Every ordered pair of kinds, the first asked by one owner and the second by the other, and the round in which both owners ask for all four. */
const ROUNDS: readonly (readonly Attempt[])[] = [
  ...KINDS.flatMap((first) => KINDS.map((second): readonly Attempt[] => [{ kind: first, caller: 0 }, { kind: second, caller: 1 }])),
  KINDS.flatMap((kind): Attempt[] => [
    { kind, caller: 0 },
    { kind, caller: 1 },
  ]),
];
const REPEATS = 2;

const count = (outcomes: readonly Outcome[], kind: Kind): number => outcomes.filter((outcome) => outcome.kind === kind && outcome.status === 200).length;
const occurrences = (actions: readonly string[], action: string): number => actions.filter((candidate) => candidate === action).length;

async function round(attempts: readonly Attempt[]): Promise<void> {
  const owners = [await harness.person(world), await harness.person(world)] as const;
  const admin = { account: await seedAccount(database(), { password: null }) };
  const member = { account: await seedAccount(database(), { password: null }) };
  const { workspaceId } = await harness.workspaceOf([
    { person: owners[0], role: "owner" },
    { person: owners[1], role: "owner" },
    { person: admin, role: "admin" },
    { person: member, role: "member" },
  ]);

  const responses = await Promise.all(
    attempts.map(async (attempt): Promise<Outcome> => {
      const caller = owners[attempt.caller];
      const { method, path, body } = call(attempt.kind, owners[attempt.caller === 0 ? 1 : 0]);
      const response = await send(world, method, path, { cookie: caller.cookie }, body);
      return { ...attempt, status: response.status };
    }),
  );

  const label = JSON.stringify(responses);
  const transferred = new Set(responses.filter((outcome) => outcome.kind === "transfer" && outcome.status === 200).map((outcome) => outcome.caller));
  for (const outcome of responses) {
    // A transfer that steps the caller down rotates the caller's session token, which ends the session the
    // caller's other calls of the round carry; no other call may be refused as unauthenticated.
    const allowed = [200, 403, 404, 409, ...(transferred.has(outcome.caller) ? [401] : [])];
    expect(allowed, `the status of ${outcome.kind} by owner ${String(outcome.caller)} in ${label}`).toContain(outcome.status);
  }
  expect(count(responses, "demote") + count(responses, "remove") + count(responses, "leave") + count(responses, "transfer"), `some call is judged first and succeeds in ${label}`).toBeGreaterThan(0);

  const roles = await harness.rolesOf(workspaceId);
  // Membership: exactly the owners no successful call removed or made leave, and the two who did not take part.
  const gone = new Set<string>();
  for (const outcome of responses.filter((candidate) => candidate.status === 200)) {
    if (outcome.kind === "leave") {
      gone.add(owners[outcome.caller].account.id);
    }
    if (outcome.kind === "remove") {
      gone.add(owners[outcome.caller === 0 ? 1 : 0].account.id);
    }
  }
  const expectedMembers = [admin.account.id, member.account.id, ...owners.map((owner) => owner.account.id).filter((id) => !gone.has(id))].sort();
  expect(Object.keys(roles).sort(), `the members after ${label}`).toEqual(expectedMembers);
  // Roles: the workspace keeps an owner, the owners left are owners or admins, and nobody else's role moved.
  expect(Object.values(roles).filter((role) => role === "owner").length, `the workspace keeps an owner after ${label}`).toBeGreaterThanOrEqual(1);
  expect(roles[admin.account.id], `the admin after ${label}`).toBe("admin");
  expect(roles[member.account.id], `the member after ${label}`).toBe("member");
  for (const owner of owners) {
    const role = roles[owner.account.id];
    expect(role === undefined || role === "owner" || role === "admin", `${String(role)} is a role an owner can end with after ${label}`).toBe(true);
  }
  // Audit: one event for each change that was made. A demotion of an owner who was an admin already answers 200 and writes none.
  const actions = await harness.auditActions(workspaceId);
  expect(occurrences(actions, "member.removed"), `member.removed after ${label}`).toBe(count(responses, "remove"));
  expect(occurrences(actions, "member.left"), `member.left after ${label}`).toBe(count(responses, "leave"));
  expect(occurrences(actions, "workspace.ownership_transferred"), `workspace.ownership_transferred after ${label}`).toBe(count(responses, "transfer"));
  expect(occurrences(actions, "member.role_changed"), `member.role_changed after ${label}`).toBeLessThanOrEqual(count(responses, "demote"));
  expect(actions.length, `no other audit event after ${label}`).toBe(
    occurrences(actions, "member.removed") + occurrences(actions, "member.left") + occurrences(actions, "workspace.ownership_transferred") + occurrences(actions, "member.role_changed"),
  );
}

describe("the last-owner rule under concurrent calls", () => {
  it.each(ROUNDS.map((attempts) => [attempts.map((attempt) => `${attempt.kind} by owner ${String(attempt.caller)}`).join(", "), attempts] as const))(
    "keeps one owner and corrupts no role when %s are asked at the same moment",
    async (_name, attempts) => {
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        await round(attempts);
      }
    },
    HOOK_TIMEOUT_MS,
  );
});

describe("the last-owner rule for an owner who is alone", () => {
  it.each([
    ["demotes themselves", "PATCH", (id: string) => `${MEMBERS}/${id}`, { role: "admin" }],
    ["removes themselves", "DELETE", (id: string) => `${MEMBERS}/${id}`, { content: "transfer" }],
    ["leaves", "POST", () => LEAVE, { content: "transfer" }],
  ] as const)("answers 409 when the only owner %s, and the workspace keeps its owner and writes no audit event", async (_name, method, path, body) => {
    const owner = await harness.person(world);
    const admin = { account: await seedAccount(database(), { password: null }) };
    const { workspaceId } = await harness.workspaceOf([
      { person: owner, role: "owner" },
      { person: admin, role: "admin" },
    ]);

    const response = await send(world, method, path(owner.account.id), { cookie: owner.cookie }, body);

    expect(response.status).toBe(409);
    expect(await harness.rolesOf(workspaceId)).toEqual({ [owner.account.id]: "owner", [admin.account.id]: "admin" });
    expect(await harness.auditActions(workspaceId)).toEqual([]);
  });
});
