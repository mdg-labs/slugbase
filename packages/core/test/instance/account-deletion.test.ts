import { describe, expect, it } from "vitest";
import {
  deleteInstanceAccount,
  type AccountDeletionGuardInput,
  type InstanceAccountDeletionRequest,
  type InstanceAccountDeletionScope,
  type InstanceAccountDeletionStore,
  type InstanceAccountDeletionStoreOutcome,
  type WorkspaceDeletionGuardResult,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const SHARED = { id: "0192f3a0-cccc-7000-8000-000000000001", name: "Shared" };
const OTHER = { id: "0192f3a0-cccc-7000-8000-000000000004", name: "Other" };
const FIRST = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "First sole" };
const SECOND = { id: "0192f3a0-cccc-7000-8000-000000000003", name: "Second sole" };
const EVENT_ID = "0192f3a0-aaaa-7000-8000-000000000001";
const ASK = { accountId: ACCOUNT, ipPrefix: "203.0.0.0/16" };

interface WorldOptions {
  scope?: InstanceAccountDeletionScope;
  /** What the guard answers for an input; a function that throws stands for a guard that cannot answer. */
  guard?: (input: AccountDeletionGuardInput) => Promise<WorkspaceDeletionGuardResult<"billing_active">>;
  deleted?: InstanceAccountDeletionStoreOutcome;
}

function world({ scope = { kind: "ok", blocking: [], soleMember: [] }, guard = () => Promise.resolve({ outcome: "allow" }), deleted = "deleted" }: WorldOptions = {}) {
  const log: string[] = [];
  const guarded: AccountDeletionGuardInput[] = [];
  const requests: InstanceAccountDeletionRequest[] = [];
  const store: InstanceAccountDeletionStore = {
    scope(accountId) {
      log.push(`scope ${accountId}`);
      return Promise.resolve(scope);
    },
    delete(request) {
      log.push("delete");
      requests.push(request);
      return Promise.resolve(deleted);
    },
  };
  return {
    log,
    guarded,
    requests,
    dependencies: {
      store,
      guard: (input: AccountDeletionGuardInput) => {
        log.push("guard");
        guarded.push(input);
        return guard(input);
      },
      newId: () => EVENT_ID,
    },
  };
}

describe("deleting an account as an instance admin", () => {
  it("deletes the account and the workspaces where it is the only member, and announces account.deleted once", async () => {
    const { dependencies, requests, log } = world({ scope: { kind: "ok", blocking: [], soleMember: [FIRST, SECOND] } });

    const outcome = await deleteInstanceAccount(dependencies, ASK);

    expect(outcome).toEqual({ kind: "deleted", workspaces: [FIRST, SECOND] });
    expect(requests).toEqual([
      {
        accountId: ACCOUNT,
        soleWorkspaceIds: [FIRST.id, SECOND.id],
        eventId: EVENT_ID,
        ipPrefix: ASK.ipPrefix,
        events: [{ eventId: EVENT_ID, name: "account.deleted", payload: { accountId: ACCOUNT } }],
      },
    ]);
    expect(log).toEqual([`scope ${ACCOUNT}`, "guard", "guard", "guard", "delete"]);
  });

  it("asks the guard for the account and then for each workspace, each naming the account that is deleted", async () => {
    const { dependencies, guarded } = world({ scope: { kind: "ok", blocking: [], soleMember: [FIRST, SECOND] } });

    await deleteInstanceAccount(dependencies, ASK);

    expect(guarded).toEqual([
      { kind: "account", accountId: ACCOUNT },
      { kind: "workspace", accountId: ACCOUNT, workspaceId: FIRST.id },
      { kind: "workspace", accountId: ACCOUNT, workspaceId: SECOND.id },
    ]);
  });

  it("names each workspace the account is the only owner of and that has other members, and asks no guard and deletes nothing", async () => {
    const { dependencies, log } = world({ scope: { kind: "ok", blocking: [SHARED, OTHER], soleMember: [FIRST] } });

    expect(await deleteInstanceAccount(dependencies, ASK)).toEqual({ kind: "last_owner", workspaces: [SHARED, OTHER] });
    expect(log).toEqual([`scope ${ACCOUNT}`]);
  });

  it.each(["unknown_account", "last_instance_admin", "self"] as const)("answers %s from the scope before the guard is asked, and deletes nothing", async (kind) => {
    const { dependencies, log } = world({ scope: { kind } });

    expect(await deleteInstanceAccount(dependencies, ASK)).toEqual({ kind });
    expect(log).toEqual([`scope ${ACCOUNT}`]);
  });

  it("answers the code of a guard that refuses the account, and deletes nothing", async () => {
    const { dependencies, log } = world({
      scope: { kind: "ok", blocking: [], soleMember: [FIRST] },
      guard: (input) => Promise.resolve(input.kind === "account" ? { outcome: "refuse", code: "billing_active" } : { outcome: "allow" }),
    });

    expect(await deleteInstanceAccount(dependencies, ASK)).toEqual({ kind: "refused", code: "billing_active" });
    expect(log).toEqual([`scope ${ACCOUNT}`, "guard"]);
  });

  it("answers the code of a guard that refuses the second workspace, after it allowed the first, and deletes nothing", async () => {
    const { dependencies, log } = world({
      scope: { kind: "ok", blocking: [], soleMember: [FIRST, SECOND] },
      guard: (input) => Promise.resolve(input.kind === "workspace" && input.workspaceId === SECOND.id ? { outcome: "refuse", code: "billing_active" } : { outcome: "allow" }),
    });

    expect(await deleteInstanceAccount(dependencies, ASK)).toEqual({ kind: "refused", code: "billing_active" });
    expect(log).toEqual([`scope ${ACCOUNT}`, "guard", "guard", "guard"]);
  });

  it("rejects when the guard cannot answer, so the transaction of the caller does not commit, and deletes nothing", async () => {
    const { dependencies, log } = world({
      scope: { kind: "ok", blocking: [], soleMember: [FIRST] },
      guard: () => Promise.reject(new Error("the billing service is down")),
    });

    await expect(deleteInstanceAccount(dependencies, ASK)).rejects.toThrow("the billing service is down");
    expect(log).toEqual([`scope ${ACCOUNT}`, "guard"]);
  });

  it.each(["unavailable", "unknown_account", "last_instance_admin", "self"] as const)("answers %s when the database answers it to the deletion, as the locks of the scope make it impossible and the function checks again", async (answer) => {
    const { dependencies } = world({ deleted: answer });

    expect(await deleteInstanceAccount(dependencies, ASK)).toEqual({ kind: answer });
  });
});
