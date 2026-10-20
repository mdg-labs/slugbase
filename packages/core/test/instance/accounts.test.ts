import { describe, expect, it } from "vitest";
import { listInstanceAccounts, updateInstanceAccount, type InstanceAccount, type InstanceAccountChange, type InstanceAccountStore, type InstanceAccountUpdateOutcome } from "../../src/index.ts";

const TARGET = "0192f3a0-bbbb-7000-8000-0000000000aa";

const account: InstanceAccount = {
  id: TARGET,
  displayName: "Ada",
  email: "ada@example.test",
  emailVerified: true,
  mfaEnabled: false,
  isInstanceAdmin: false,
  disabled: false,
  lastSignInAt: null,
  workspaceCount: 0,
};

interface Call {
  readonly accountId: string;
  readonly change: InstanceAccountChange;
  readonly notify: boolean;
  readonly eventIds: { readonly admin: string; readonly disabled: string };
  readonly ipPrefix: string | null;
}

function stubStore(answer?: InstanceAccountUpdateOutcome): { store: InstanceAccountStore; calls: Call[]; lists: string[] } {
  const calls: Call[] = [];
  const lists: string[] = [];
  const store: InstanceAccountStore = {
    listAccounts: (eventId) => {
      lists.push(eventId);
      return Promise.resolve([]);
    },
    updateAccount: (accountId, change, notify, eventIds, ipPrefix) => {
      calls.push({ accountId, change, notify, eventIds, ipPrefix });
      return Promise.resolve(
        answer ?? {
          kind: "updated",
          account: { ...account, isInstanceAdmin: change.isInstanceAdmin ?? account.isInstanceAdmin, disabled: change.disabled ?? account.disabled },
          adminChanged: change.isInstanceAdmin !== undefined,
          disabledChanged: change.disabled !== undefined,
        },
      );
    },
  };
  return { store, calls, lists };
}

let counter = 0;
const newId = (): string => {
  counter += 1;
  return `0192f3a0-bbbb-7000-8000-${counter.toString(16).padStart(12, "0")}`;
};

describe("listInstanceAccounts", () => {
  it("asks the store under a fresh event id", async () => {
    const { store, lists } = stubStore();
    await listInstanceAccounts({ store, newId }, { ipPrefix: "203.0.0.0/16" });
    expect(lists).toHaveLength(1);
  });
});

describe("updateInstanceAccount", () => {
  it("hands the store the fields the ask names, under fresh event ids and the request's network, in one call", async () => {
    const { store, calls } = stubStore();

    const outcome = await updateInstanceAccount({ store, newId }, { accountId: TARGET, isInstanceAdmin: true, notify: true, ipPrefix: "203.0.0.0/16" });

    expect(outcome).toEqual({ kind: "updated", account: { ...account, isInstanceAdmin: true }, adminChanged: true, disabledChanged: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accountId: TARGET, change: { isInstanceAdmin: true }, notify: true, ipPrefix: "203.0.0.0/16" });
    expect(calls[0]?.change).not.toHaveProperty("disabled");
    expect(calls[0]?.eventIds.admin).not.toBe(calls[0]?.eventIds.disabled);
  });

  it("asks for the flag and the disabled state together, in one call of the store, and passes whether mail can be queued", async () => {
    const { store, calls } = stubStore();

    const outcome = await updateInstanceAccount({ store, newId }, { accountId: TARGET, isInstanceAdmin: false, disabled: true, notify: false, ipPrefix: null });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ change: { isInstanceAdmin: false, disabled: true }, notify: false });
    expect(outcome).toEqual({ kind: "updated", account: { ...account, isInstanceAdmin: false, disabled: true }, adminChanged: true, disabledChanged: true });
  });

  it.each<InstanceAccountUpdateOutcome>([
    { kind: "last_instance_admin", field: "isInstanceAdmin" },
    { kind: "last_instance_admin", field: "disabled" },
    { kind: "unknown_account" },
    { kind: "updated", account, adminChanged: false, disabledChanged: false },
  ])("answers what the store answered: %j", async (answer) => {
    const { store } = stubStore(answer);
    expect(await updateInstanceAccount({ store, newId }, { accountId: TARGET, disabled: true, notify: true, ipPrefix: null })).toEqual(answer);
  });

  it("refuses an ask that names neither field, touching the store not at all", async () => {
    const { store, calls } = stubStore();
    await expect(updateInstanceAccount({ store, newId }, { accountId: TARGET, notify: true, ipPrefix: null })).rejects.toThrow(RangeError);
    expect(calls).toEqual([]);
  });
});
