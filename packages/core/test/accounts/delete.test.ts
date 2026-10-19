import { describe, expect, it } from "vitest";
import {
  deleteAccount,
  type AccountDeletionAsk,
  type AccountDeletionGuardInput,
  type AccountDeletionRequest,
  type AccountDeletionScope,
  type AccountDeletionStore,
  type WorkspaceDeletionGuardResult,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";
const SHARED = { id: "0192f3a0-cccc-7000-8000-000000000001", name: "Shared" };
const FIRST = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "First sole" };
const SECOND = { id: "0192f3a0-cccc-7000-8000-000000000003", name: "Second sole" };
const EVENT_ID = "0192f3a0-aaaa-7000-8000-000000000001";

const ASK: AccountDeletionAsk = { accountId: ACCOUNT, accountEmail: "Ada@Example.test", typedEmail: "ada@example.test" };

interface WorldOptions {
  scope?: AccountDeletionScope;
  /** What the guard answers for an input; a function that throws stands for a guard that cannot answer. */
  guard?: (input: AccountDeletionGuardInput) => Promise<WorkspaceDeletionGuardResult<"billing_active">>;
  deletes?: boolean;
}

function world({ scope = { blocking: [], soleMember: [] }, guard = () => Promise.resolve({ outcome: "allow" }), deletes = true }: WorldOptions = {}) {
  const log: string[] = [];
  const guarded: AccountDeletionGuardInput[] = [];
  const requests: AccountDeletionRequest[] = [];
  const store: AccountDeletionStore = {
    scope() {
      log.push("scope");
      return Promise.resolve(scope);
    },
    delete(request) {
      log.push("delete");
      requests.push(request);
      return Promise.resolve(deletes);
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

describe("deleting an account", () => {
  it("deletes the account and the workspaces where it is the only member, and announces account.deleted once", async () => {
    const { dependencies, requests, log } = world({ scope: { blocking: [], soleMember: [FIRST, SECOND] } });

    const outcome = await deleteAccount(dependencies, ASK);

    expect(outcome).toEqual({ kind: "deleted", workspaces: [FIRST, SECOND] });
    expect(requests).toEqual([{ soleWorkspaceIds: [FIRST.id, SECOND.id], events: [{ eventId: EVENT_ID, name: "account.deleted", payload: { accountId: ACCOUNT } }] }]);
    expect(log).toEqual(["scope", "guard", "guard", "guard", "delete"]);
  });

  it("takes the typed address without regard to case, width or surrounding space, and refuses another before anything is read", async () => {
    for (const typed of ["ADA@EXAMPLE.TEST", "  ada@example.test ", "ａｄａ@example.test"]) {
      const { dependencies } = world();
      expect(await deleteAccount(dependencies, { ...ASK, typedEmail: typed })).toEqual({ kind: "deleted", workspaces: [] });
    }
    for (const typed of ["", "grace@example.test", "ada@example.test.evil", "ada"]) {
      const { dependencies, log } = world();
      expect(await deleteAccount(dependencies, { ...ASK, typedEmail: typed })).toEqual({ kind: "email_mismatch" });
      expect(log).toEqual([]);
    }
  });

  it("refuses with the workspaces that would be left without an owner, and asks no guard and writes nothing", async () => {
    const { dependencies, log } = world({ scope: { blocking: [SHARED], soleMember: [FIRST] } });

    expect(await deleteAccount(dependencies, ASK)).toEqual({ kind: "last_owner", workspaces: [SHARED] });
    expect(log).toEqual(["scope"]);
  });

  it("asks the guard for the account first and then for each workspace that goes with it, as the account that asks", async () => {
    const { dependencies, guarded } = world({ scope: { blocking: [], soleMember: [FIRST, SECOND] } });

    await deleteAccount(dependencies, ASK);

    expect(guarded).toEqual([
      { kind: "account", accountId: ACCOUNT },
      { kind: "workspace", accountId: ACCOUNT, workspaceId: FIRST.id },
      { kind: "workspace", accountId: ACCOUNT, workspaceId: SECOND.id },
    ]);
  });

  it("writes nothing when the guard refuses the account, and asks it no further", async () => {
    const { dependencies, guarded, log } = world({
      scope: { blocking: [], soleMember: [FIRST] },
      guard: () => Promise.resolve({ outcome: "refuse", code: "billing_active" }),
    });

    expect(await deleteAccount(dependencies, ASK)).toEqual({ kind: "refused", code: "billing_active" });
    expect(guarded).toHaveLength(1);
    expect(log).not.toContain("delete");
  });

  it("writes nothing when the guard refuses the second workspace", async () => {
    const { dependencies, guarded, log } = world({
      scope: { blocking: [], soleMember: [FIRST, SECOND] },
      guard: (input) => Promise.resolve(input.kind === "workspace" && input.workspaceId === SECOND.id ? { outcome: "refuse", code: "billing_active" } : { outcome: "allow" }),
    });

    expect(await deleteAccount(dependencies, ASK)).toEqual({ kind: "refused", code: "billing_active" });
    expect(guarded).toHaveLength(3);
    expect(log).not.toContain("delete");
  });

  it("rejects, with nothing written, when the guard cannot answer", async () => {
    const { dependencies, log } = world({
      scope: { blocking: [], soleMember: [FIRST] },
      guard: () => Promise.reject(new Error("the guard timed out")),
    });

    await expect(deleteAccount(dependencies, ASK)).rejects.toThrow("the guard timed out");
    expect(log).not.toContain("delete");
  });

  it("is unavailable, announcing nothing, when the store no longer finds the account or the workspaces as it read them", async () => {
    const { dependencies } = world({ deletes: false });

    expect(await deleteAccount(dependencies, ASK)).toEqual({ kind: "unavailable" });
  });
});
