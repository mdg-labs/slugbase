import { describe, expect, it } from "vitest";
import {
  AccountAccessModeError,
  accessModeChangeOf,
  endAccessMode,
  setAccountAccessMode,
  setInstanceAccountAccessMode,
  type AccessModeEndRequest,
  type AccessModeEndStore,
  type AccessModeEndStoreOutcome,
  type AccessModeOutcome,
  type AccountAccessModeTransaction,
  type AccountDeletionScope,
  type AccessModeRequest,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-aaaa-7000-8000-00000000000A";
const OTHER = "0192f3a0-aaaa-7000-8000-000000000002";
const WORKSPACE = "0192f3a0-bbbb-7000-8000-000000000001";
const SOLO = "0192f3a0-bbbb-7000-8000-000000000002";
const EVENT = "0192f3a0-eeee-7000-8000-000000000001";
const UNTIL = new Date("2026-12-01T10:00:00.000Z");

function transaction(options: { accountId?: string; workspaceId?: string | undefined; outcome?: AccessModeOutcome } = {}) {
  const requests: AccessModeRequest[] = [];
  const tx: AccountAccessModeTransaction = {
    accountId: options.accountId ?? ACCOUNT,
    workspaceId: "workspaceId" in options ? options.workspaceId : undefined,
    setAccessMode(request) {
      requests.push(request);
      return Promise.resolve(options.outcome ?? "set");
    },
    newId: () => EVENT,
  };
  return { tx, requests };
}

describe("setAccountAccessMode", () => {
  it("sets the export-only mode with the end date and the end action under a fresh event identifier", async () => {
    const { tx, requests } = transaction();

    const result = await setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "exportOnly", until: UNTIL, endAction: "delete" });

    expect(result).toEqual({ outcome: "set" });
    expect(requests).toEqual([{ eventId: EVENT, change: { mode: "exportOnly", until: UNTIL, endAction: "delete" } }]);
  });

  it("clears the mode with full alone", async () => {
    const { tx, requests } = transaction({ outcome: "cleared" });

    expect(await setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "full" })).toEqual({ outcome: "cleared" });
    expect(requests).toEqual([{ eventId: EVENT, change: { mode: "full" } }]);
  });

  it("recognises the account whatever the case of its identifier", async () => {
    const { tx } = transaction();
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT.toLowerCase(), mode: "full" })).resolves.toEqual({ outcome: "set" });
  });

  it.each<AccessModeOutcome>(["unchanged", "unknown_account", "account_disabled", "instance_admin", "until_too_soon"])("answers the database's refusal %s as the outcome", async (outcome) => {
    const { tx } = transaction({ outcome });
    expect(await setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "exportOnly", until: UNTIL, endAction: "disable" })).toEqual({ outcome });
  });

  it("throws, asking the database nothing, for another account's transaction or one that acts in a workspace", async () => {
    const other = transaction({ accountId: OTHER });
    await expect(setAccountAccessMode(other.tx, { accountId: ACCOUNT, mode: "full" })).rejects.toThrow(AccountAccessModeError);
    const inWorkspace = transaction({ workspaceId: WORKSPACE });
    await expect(setAccountAccessMode(inWorkspace.tx, { accountId: ACCOUNT, mode: "full" })).rejects.toThrow(AccountAccessModeError);
    expect(other.requests).toEqual([]);
    expect(inWorkspace.requests).toEqual([]);
  });

  it("refuses a request that is not well formed before it asks the database", async () => {
    const { tx, requests } = transaction();
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "exportOnly", endAction: "delete" })).rejects.toThrow(RangeError);
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "exportOnly", until: UNTIL })).rejects.toThrow(RangeError);
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "exportOnly", until: new Date(Number.NaN), endAction: "delete" })).rejects.toThrow(RangeError);
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "full", until: UNTIL })).rejects.toThrow(RangeError);
    await expect(setAccountAccessMode(tx, { accountId: ACCOUNT, mode: "full", endAction: "delete" })).rejects.toThrow(RangeError);
    expect(requests).toEqual([]);
    expect(() => accessModeChangeOf({ mode: "exportOnly", until: UNTIL, endAction: "archive" as never })).toThrow(RangeError);
  });
});

describe("setInstanceAccountAccessMode", () => {
  it("hands the store the change, a fresh event identifier, whether mail is configured and the network", async () => {
    const calls: unknown[][] = [];
    const store = {
      setAccessMode: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve<AccessModeOutcome>("set");
      },
    };

    const outcome = await setInstanceAccountAccessMode(
      { store, newId: () => EVENT },
      { accountId: ACCOUNT, change: { mode: "exportOnly", until: UNTIL, endAction: "disable" }, notify: true, ipPrefix: "203.0.0.0/16" },
    );

    expect(outcome).toBe("set");
    expect(calls).toEqual([[ACCOUNT, { mode: "exportOnly", until: UNTIL, endAction: "disable" }, true, EVENT, "203.0.0.0/16"]]);
  });
});

function endStore(options: { scope?: Partial<AccountDeletionScope>; outcomes?: AccessModeEndStoreOutcome[] } = {}) {
  const requests: AccessModeEndRequest[] = [];
  const outcomes = [...(options.outcomes ?? ["deleted"])];
  let scopes = 0;
  const store: AccessModeEndStore = {
    scope: () => {
      scopes += 1;
      return Promise.resolve({ blocking: [], soleMember: [], lastInstanceAdmin: false, ...options.scope });
    },
    end: (request) => {
      requests.push(request);
      return Promise.resolve(outcomes.shift() ?? "unavailable");
    },
  };
  return { store, requests, scopes: () => scopes };
}

let counter = 0;
const newId = (): string => `0192f3a0-eeee-7000-8000-${(counter += 1).toString(16).padStart(12, "0")}`;

describe("endAccessMode", () => {
  it("disables an account whose end action is disable, reading no deletion scope", async () => {
    const { store, requests, scopes } = endStore({ outcomes: ["disabled"] });

    expect(await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "disable" })).toEqual({ kind: "disabled", deletionBlocked: false });
    expect(requests.map(({ action, soleWorkspaceIds, events }) => ({ action, soleWorkspaceIds, events }))).toEqual([{ action: "disable", soleWorkspaceIds: [], events: [] }]);
    expect(scopes()).toBe(0);
  });

  it("deletes an account with the workspaces it is the only member of, announcing account.deleted", async () => {
    const { store, requests } = endStore({ scope: { soleMember: [{ id: SOLO, name: "Mine" }] }, outcomes: ["deleted"] });

    const outcome = await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "delete" });

    expect(outcome).toEqual({ kind: "deleted", workspaces: [{ id: SOLO, name: "Mine" }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: "delete", soleWorkspaceIds: [SOLO], events: [{ name: "account.deleted", payload: { accountId: ACCOUNT } }] });
  });

  it("disables instead, asking for no deletion, when the account is the only owner of a workspace with other members", async () => {
    const { store, requests } = endStore({ scope: { blocking: [{ id: WORKSPACE, name: "Shared" }] }, outcomes: ["disabled"] });

    expect(await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "disabled", deletionBlocked: true });
    expect(requests.map((request) => request.action)).toEqual(["disable"]);
  });

  it("disables instead when the account is the last enabled instance admin", async () => {
    const { store, requests } = endStore({ scope: { lastInstanceAdmin: true }, outcomes: ["disabled"] });

    expect(await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "disabled", deletionBlocked: true });
    expect(requests.map((request) => request.action)).toEqual(["disable"]);
  });

  it("disables instead when the database finds an owner it must keep after the scope was read", async () => {
    const { store, requests } = endStore({ outcomes: ["blocked", "disabled"] });

    expect(await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "disabled", deletionBlocked: true });
    expect(requests.map((request) => request.action)).toEqual(["delete", "disable"]);
  });

  it("answers not_due when the period was ended already and unavailable when the workspaces changed, ending nothing", async () => {
    expect(await endAccessMode({ store: endStore({ outcomes: ["not_due"] }).store, newId }, { accountId: ACCOUNT, endAction: "disable" })).toEqual({ kind: "not_due" });
    expect(await endAccessMode({ store: endStore({ outcomes: ["not_due"] }).store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "not_due" });
    expect(await endAccessMode({ store: endStore({ outcomes: ["unavailable"] }).store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "unavailable" });
    expect(await endAccessMode({ store: endStore({ outcomes: ["unavailable"] }).store, newId }, { accountId: ACCOUNT, endAction: "disable" })).toEqual({ kind: "unavailable" });
  });

  it("does not turn an unavailable fallback into a success", async () => {
    const { store } = endStore({ outcomes: ["blocked", "unavailable"] });
    expect(await endAccessMode({ store, newId }, { accountId: ACCOUNT, endAction: "delete" })).toEqual({ kind: "unavailable" });
  });
});
