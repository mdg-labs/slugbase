import { describe, expect, it } from "vitest";
import {
  PERSONAL_WORKSPACE_NAME_SUFFIX,
  PersonalWorkspaceUnavailableError,
  provisionPersonalWorkspace,
  type PersonalWorkspaceOutcome,
  type PersonalWorkspaceRequest,
  type PersonalWorkspaceStore,
} from "../../src/workspaces/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

/** A store that keeps the first workspace it is asked for, as the database does, and answers `exists` to every later request. */
function memoryStore(account: "enabled" | "missing" = "enabled") {
  const requests: PersonalWorkspaceRequest[] = [];
  const created: PersonalWorkspaceRequest[] = [];
  const store: PersonalWorkspaceStore = {
    create(request) {
      requests.push(request);
      if (account === "missing") {
        return Promise.resolve(undefined);
      }
      const outcome: PersonalWorkspaceOutcome = created.length === 0 ? "created" : "exists";
      if (outcome === "created") {
        created.push(request);
      }
      return Promise.resolve(outcome);
    },
  };
  return { store, requests, created };
}

describe("provisionPersonalWorkspace", () => {
  it("asks for the personal name of the account's workspace with a fresh identifier and announces workspace.created for it", async () => {
    const { store, requests } = memoryStore();

    expect(await provisionPersonalWorkspace({ store, newId: ids() }, ACCOUNT)).toBe("created");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.accountId).toBe(ACCOUNT);
    expect(request?.nameSuffix).toBe(PERSONAL_WORKSPACE_NAME_SUFFIX);
    expect(request?.nameSuffix).toBe("'s workspace");
    expect(request?.events).toHaveLength(1);
    expect(request?.events[0]?.name).toBe("workspace.created");
    expect(request?.events[0]?.payload).toEqual({ workspaceId: request?.workspaceId, accountId: ACCOUNT });
    expect(request?.events[0]?.eventId).toMatch(/^0192f3a0-aaaa-7000-8000-/);
    expect(request?.events[0]?.eventId).not.toBe(request?.workspaceId);
  });

  it("is idempotent: the second call for one account writes nothing and reports that the workspace exists", async () => {
    const { store, created } = memoryStore();
    const deps = { store, newId: ids() };

    expect(await provisionPersonalWorkspace(deps, ACCOUNT)).toBe("created");
    expect(await provisionPersonalWorkspace(deps, ACCOUNT)).toBe("exists");

    expect(created).toHaveLength(1);
  });

  it("refuses to report success for an account that does not exist or is disabled, so the surrounding transaction does not commit", async () => {
    const { store } = memoryStore("missing");

    await expect(provisionPersonalWorkspace({ store, newId: ids() }, ACCOUNT)).rejects.toBeInstanceOf(PersonalWorkspaceUnavailableError);
  });

  it("lets a store failure through", async () => {
    const store: PersonalWorkspaceStore = { create: () => Promise.reject(new Error("the database is down")) };

    await expect(provisionPersonalWorkspace({ store, newId: ids() }, ACCOUNT)).rejects.toThrow("the database is down");
  });
});
