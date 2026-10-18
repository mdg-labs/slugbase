import { describe, expect, it } from "vitest";
import {
  canCreateWorkspace,
  createAuditWriter,
  createWorkspace,
  type AuditRecord,
  type AuditStore,
  type WorkspaceCreationRequest,
  type WorkspaceStore,
} from "../../src/index.ts";

const ACCOUNT = "0192f3a0-bbbb-7000-8000-000000000001";

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `0192f3a0-aaaa-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}

/** The stores of one transaction: what they were asked for in order, and what stays when it ends. */
function world(options: { account?: "enabled" | "missing"; auditFails?: boolean } = {}) {
  const log: string[] = [];
  const requests: WorkspaceCreationRequest[] = [];
  const audits: AuditRecord[] = [];
  const store: WorkspaceStore = {
    create(request) {
      log.push("workspace");
      requests.push(request);
      return Promise.resolve(options.account !== "missing");
    },
  };
  const auditStore: AuditStore = {
    insert(record) {
      log.push("audit");
      if (options.auditFails === true) {
        return Promise.reject(new Error("the database refused"));
      }
      audits.push(record);
      return Promise.resolve();
    },
  };
  const newId = ids();
  return { log, requests, audits, dependencies: { store, audit: createAuditWriter({ store: auditStore, newId }), newId } };
}

const ASKING = { accountId: ACCOUNT, displayName: "Ada", emailVerified: true, creationAllowed: true, ipPrefix: "203.0.0.0/16", name: "Research" };

describe("canCreateWorkspace", () => {
  it("is true only for a verified account on a deployment that lets accounts create workspaces", () => {
    expect(canCreateWorkspace({ creationAllowed: true, emailVerified: true })).toBe(true);
    expect(canCreateWorkspace({ creationAllowed: true, emailVerified: false })).toBe(false);
    expect(canCreateWorkspace({ creationAllowed: false, emailVerified: true })).toBe(false);
    expect(canCreateWorkspace({ creationAllowed: false, emailVerified: false })).toBe(false);
  });
});

describe("createWorkspace", () => {
  it("creates the workspace for the asking account, writes workspace.created to the audit log and announces it, in that order", async () => {
    const { dependencies, requests, audits, log } = world();

    const outcome = await createWorkspace(dependencies, ASKING);

    expect(outcome.kind).toBe("created");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.accountId).toBe(ACCOUNT);
    expect(request?.name).toBe("Research");
    expect(request?.events).toEqual([
      { eventId: expect.stringMatching(/^0192f3a0-aaaa-7000-8000-/) as string, name: "workspace.created", payload: { workspaceId: request?.workspaceId, accountId: ACCOUNT } },
    ]);
    expect(outcome.kind === "created" && outcome.workspaceId).toBe(request?.workspaceId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      workspaceId: request?.workspaceId,
      actorType: "account",
      actorAccountId: ACCOUNT,
      actorLabel: "Ada",
      action: "workspace.created",
      entityType: "workspace",
      entityId: request?.workspaceId,
      metadata: { name: "Research" },
      ipPrefix: "203.0.0.0/16",
    });
    expect(log).toEqual(["workspace", "audit"]);
  });

  it("uses fresh identifiers for the workspace, the event and the audit row", async () => {
    const { dependencies, requests, audits } = world();

    await createWorkspace(dependencies, ASKING);

    const used = [requests[0]?.workspaceId, requests[0]?.events[0]?.eventId, audits[0]?.id];
    expect(new Set(used).size).toBe(3);
  });

  it("writes nothing when the deployment does not let accounts create workspaces", async () => {
    const { dependencies, log } = world();

    expect(await createWorkspace(dependencies, { ...ASKING, creationAllowed: false })).toEqual({ kind: "not_allowed" });
    expect(log).toEqual([]);
  });

  it("writes nothing for an account whose address is not verified", async () => {
    const { dependencies, log } = world();

    expect(await createWorkspace(dependencies, { ...ASKING, emailVerified: false })).toEqual({ kind: "unverified" });
    expect(log).toEqual([]);
  });

  it("judges the policy before the account, so an unverified account learns nothing a closed deployment withholds", async () => {
    const { dependencies } = world();

    expect(await createWorkspace(dependencies, { ...ASKING, creationAllowed: false, emailVerified: false })).toEqual({ kind: "not_allowed" });
  });

  it("writes no audit row and announces nothing for an account that does not exist or is disabled", async () => {
    const { dependencies, audits, log } = world({ account: "missing" });

    expect(await createWorkspace(dependencies, ASKING)).toEqual({ kind: "unavailable" });
    expect(audits).toEqual([]);
    expect(log).toEqual(["workspace"]);
  });

  it("lets a failure of the audit write reach the caller, so the transaction that created the workspace does not commit", async () => {
    const { dependencies } = world({ auditFails: true });

    await expect(createWorkspace(dependencies, ASKING)).rejects.toThrow("the database refused");
  });

  it("refuses a name outside 1 to 64 characters before anything is written", async () => {
    const { dependencies, log } = world();

    for (const name of ["", "x".repeat(65)]) {
      await expect(createWorkspace(dependencies, { ...ASKING, name })).rejects.toBeInstanceOf(RangeError);
    }
    expect(log).toEqual([]);
  });

  it("counts a name by characters, as the database does", async () => {
    const { dependencies } = world();

    expect((await createWorkspace(dependencies, { ...ASKING, name: "😀".repeat(64) })).kind).toBe("created");
  });

  it("records the workspace name and nothing else in the audit metadata", async () => {
    const { dependencies, audits } = world();

    await createWorkspace(dependencies, ASKING);

    expect(Object.keys(audits[0]?.metadata ?? {})).toEqual(["name"]);
  });
});
