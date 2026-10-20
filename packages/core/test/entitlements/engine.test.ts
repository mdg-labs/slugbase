import { describe, expect, it } from "vitest";
import {
  EntitlementSourceError,
  EntitlementVersionError,
  PortUnavailable,
  createEntitlementCheck,
  createEntitlementService,
  withEntitlementChange,
  type AccountEntitlementValues,
  type EntitlementSource,
  type EntitlementVersions,
  type WorkspaceEntitlementGrant,
  type WorkspaceEntitlementValues,
} from "../../src/index.ts";

const A = "0192f3a0-aaaa-7000-8000-000000000001";
const B = "0192f3a0-bbbb-7000-8000-000000000002";
const ACCOUNT = "0192f3a0-cccc-7000-8000-000000000003";
const OTHER_ACCOUNT = "0192f3a0-dddd-7000-8000-000000000004";

const FULL: WorkspaceEntitlementValues = {
  "bookmarks.max": "unlimited",
  "seats.max": "unlimited",
  "ai.suggestions": true,
  "sharing.members": true,
  "sharing.teams": true,
  "members.invite": true,
  "teams.manage": true,
  "audit.log": true,
};

interface Rig {
  readonly source: EntitlementSource;
  readonly versions: EntitlementVersions;
  readonly reads: { versions: number; workspaces: string[]; accounts: string[] };
  readonly values: Map<string, WorkspaceEntitlementValues>;
  readonly versionOf: Map<string, number>;
  readonly accountValues: Map<string, AccountEntitlementValues>;
}

function rig(): Rig {
  const reads = { versions: 0, workspaces: [] as string[], accounts: [] as string[] };
  const values = new Map<string, WorkspaceEntitlementValues>([[A, FULL], [B, FULL]]);
  const versionOf = new Map<string, number>([[A, 1], [B, 1]]);
  const accountValues = new Map<string, AccountEntitlementValues>();
  return {
    reads,
    values,
    versionOf,
    accountValues,
    versions: {
      read: ({ workspaceId }) => {
        reads.versions += 1;
        return Promise.resolve(versionOf.get(workspaceId));
      },
    },
    source: {
      available: true,
      forWorkspace: (workspaceId) => {
        reads.workspaces.push(workspaceId);
        const grant: WorkspaceEntitlementGrant = { values: (values.has(workspaceId) ? values.get(workspaceId) : FULL) as WorkspaceEntitlementValues, upgradeAvailable: false };
        return Promise.resolve(grant);
      },
      forAccount: (accountId) => {
        reads.accounts.push(accountId);
        return Promise.resolve(accountValues.get(accountId) ?? { "workspaces.ownMax": "unlimited" });
      },
    },
  };
}

describe("the entitlement service", () => {
  it("serves an immutable set and reads the source once per version across requests", async () => {
    const world = rig();
    const service = createEntitlementService(world);

    const first = await service.forRequest({}, ACCOUNT).forWorkspace(A);
    const second = await service.forRequest({}, OTHER_ACCOUNT).forWorkspace(A);

    expect(first).toBe(second);
    expect(world.reads.workspaces).toEqual([A]);
    expect(first?.version).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.values)).toBe(true);
  });

  it("reads the version on every request, so a bump takes effect on the next one and no lifetime can serve a stale grant", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    expect((await service.forRequest({}, ACCOUNT).forWorkspace(A))?.values["members.invite"]).toBe(true);

    world.values.set(A, { ...FULL, "members.invite": false, "seats.max": 3 });
    // The row did not change yet: the cached set still answers.
    expect((await service.forRequest({}, ACCOUNT).forWorkspace(A))?.values["members.invite"]).toBe(true);
    world.versionOf.set(A, 2);
    const after = await service.forRequest({}, ACCOUNT).forWorkspace(A);

    expect(after).toMatchObject({ version: 2, values: { "members.invite": false, "seats.max": 3 } });
    expect(world.reads.versions).toBe(3);
    expect(world.reads.workspaces).toEqual([A, A]);
  });

  it("keys the cache by workspace: one workspace's version change leaves another's set cached", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    await service.forRequest({}, ACCOUNT).forWorkspace(A);
    await service.forRequest({}, ACCOUNT).forWorkspace(B);
    world.versionOf.set(A, 2);

    await service.forRequest({}, ACCOUNT).forWorkspace(A);
    await service.forRequest({}, ACCOUNT).forWorkspace(B);

    expect(world.reads.workspaces).toEqual([A, B, A]);
  });

  it("memoises per request: a set asked twice in one request reads the version once", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    const request = {};

    const [one, two] = await Promise.all([service.forRequest(request, ACCOUNT).forWorkspace(A), service.forRequest(request, ACCOUNT).forWorkspace(A)]);
    await service.forRequest(request, ACCOUNT).forWorkspace(A);

    expect(one).toBe(two);
    expect(world.reads.versions).toBe(1);
  });

  it("does not memoise a failed read for the rest of the request", async () => {
    const world = rig();
    let failing = true;
    const service = createEntitlementService({
      ...world,
      source: {
        ...world.source,
        forWorkspace: (workspaceId) => (failing ? Promise.reject(new Error("source down")) : world.source.forWorkspace(workspaceId)),
      },
    });
    const request = {};

    await expect(service.forRequest(request, ACCOUNT).forWorkspace(A)).rejects.toThrow("source down");
    failing = false;

    expect((await service.forRequest(request, ACCOUNT).forWorkspace(A))?.values["members.invite"]).toBe(true);
  });

  it("serves no set for a workspace whose version cannot be read, and drops what it cached for it", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    await service.forRequest({}, ACCOUNT).forWorkspace(A);
    world.versionOf.delete(A);

    expect(await service.forRequest({}, ACCOUNT).forWorkspace(A)).toBeUndefined();
    world.versionOf.set(A, 1);
    await service.forRequest({}, ACCOUNT).forWorkspace(A);

    expect(world.reads.workspaces).toEqual([A, A]);
  });

  it("does not let a request that read an older version replace the entry of a newer one", async () => {
    const world = rig();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const service = createEntitlementService({
      ...world,
      source: {
        ...world.source,
        forWorkspace: async (workspaceId) => {
          if (held) {
            held = false;
            await slow;
          }
          return world.source.forWorkspace(workspaceId);
        },
      },
    });

    const older = service.forRequest({}, ACCOUNT).forWorkspace(A);
    world.versionOf.set(A, 2);
    await service.forRequest({}, ACCOUNT).forWorkspace(A);
    release?.();
    await older;
    world.reads.workspaces.length = 0;

    expect((await service.forRequest({}, ACCOUNT).forWorkspace(A))?.version).toBe(2);
    expect(world.reads.workspaces).toEqual([]);
  });

  it("bounds the cache: the oldest workspace is read again once more than cacheSize are held", async () => {
    const world = rig();
    const service = createEntitlementService({ ...world, cacheSize: 1 });
    await service.forRequest({}, ACCOUNT).forWorkspace(A);
    await service.forRequest({}, ACCOUNT).forWorkspace(B);
    await service.forRequest({}, ACCOUNT).forWorkspace(A);

    expect(world.reads.workspaces).toEqual([A, B, A]);
  });

  it("asks the source for the account's values on every request and never caches them across requests", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    world.accountValues.set(ACCOUNT, { "workspaces.ownMax": 1 });
    world.accountValues.set(OTHER_ACCOUNT, { "workspaces.ownMax": 5 });

    const first = await service.forRequest({}, ACCOUNT).forAccount();
    world.accountValues.set(ACCOUNT, { "workspaces.ownMax": 2 });
    const second = await service.forRequest({}, ACCOUNT).forAccount();
    const other = await service.forRequest({}, OTHER_ACCOUNT).forAccount();

    expect(first.values["workspaces.ownMax"]).toBe(1);
    expect(second.values["workspaces.ownMax"]).toBe(2);
    expect(other.values["workspaces.ownMax"]).toBe(5);
    expect(world.reads.accounts).toEqual([ACCOUNT, ACCOUNT, OTHER_ACCOUNT]);
  });

  it("refuses a source answer outside the catalog", async () => {
    const world = rig();
    const service = createEntitlementService(world);
    const bad: unknown[] = [
      { ...FULL, "members.invite": "yes" },
      { ...FULL, "members.invite": 1 },
      { ...FULL, "seats.max": -1 },
      { ...FULL, "seats.max": 1.5 },
      { ...FULL, "bookmarks.max": "many" },
      { ...FULL, "bookmarks.max": Number.NaN },
      { ...FULL, "bookmarks.max": Number.POSITIVE_INFINITY },
      Object.fromEntries(Object.entries(FULL).filter(([key]) => key !== "audit.log")),
      null,
    ];
    for (const values of bad) {
      world.values.set(A, values as WorkspaceEntitlementValues);
      world.versionOf.set(A, (world.versionOf.get(A) ?? 0) + 1);
      await expect(service.forRequest({}, ACCOUNT).forWorkspace(A)).rejects.toBeInstanceOf(EntitlementSourceError);
    }
    world.accountValues.set(ACCOUNT, { "workspaces.ownMax": "lots" } as unknown as AccountEntitlementValues);
    await expect(service.forRequest({}, ACCOUNT).forAccount()).rejects.toBeInstanceOf(EntitlementSourceError);
  });

  it("copies only the catalog keys of a source answer", async () => {
    const world = rig();
    world.values.set(A, { ...FULL, "billing.secret": "x" } as unknown as WorkspaceEntitlementValues);
    const service = createEntitlementService(world);

    expect(Object.keys((await service.forRequest({}, ACCOUNT).forWorkspace(A))?.values ?? {}).sort()).toEqual(Object.keys(FULL).sort());
  });
});

describe("the entitlement check", () => {
  const subject = { accountId: ACCOUNT, workspaceId: A };

  it("holds a flag that is on and refuses one that is off", async () => {
    const world = rig();
    world.values.set(A, { ...FULL, "members.invite": false });
    const check = createEntitlementCheck(createEntitlementService(world));

    expect(await check("members.invite", subject, {})).toBe(false);
    expect(await check("audit.log", subject, {})).toBe(true);
  });

  it("holds a limit that is unlimited or above zero, and refuses one at zero", async () => {
    const world = rig();
    world.values.set(A, { ...FULL, "seats.max": 0, "bookmarks.max": 10 });
    const check = createEntitlementCheck(createEntitlementService(world));

    expect(await check("seats.max", subject, {})).toBe(false);
    expect(await check("bookmarks.max", subject, {})).toBe(true);
    world.accountValues.set(ACCOUNT, { "workspaces.ownMax": 0 });
    expect(await check("workspaces.ownMax", subject, {})).toBe(false);
    expect(await check("workspaces.ownMax", { accountId: OTHER_ACCOUNT }, {})).toBe(true);
  });

  it("refuses a key outside the catalog, a workspace key without a workspace and a workspace that cannot be seen", async () => {
    const world = rig();
    const check = createEntitlementCheck(createEntitlementService(world));
    world.versionOf.delete(B);

    expect(await check("probe.premium", subject, {})).toBe(false);
    expect(await check("toString", subject, {})).toBe(false);
    expect(await check("members.invite", { accountId: ACCOUNT }, {})).toBe(false);
    expect(await check("members.invite", { accountId: ACCOUNT, workspaceId: B }, {})).toBe(false);
    expect(world.reads.workspaces).toEqual([]);
  });

  it("does not grant when the source fails", async () => {
    const world = rig();
    const check = createEntitlementCheck(
      createEntitlementService({ ...world, source: { available: false, forWorkspace: () => Promise.reject(new PortUnavailable("entitlements", "unavailable")), forAccount: () => Promise.reject(new PortUnavailable("entitlements", "unavailable")) } }),
    );

    await expect(check("members.invite", subject, {})).rejects.toBeInstanceOf(PortUnavailable);
    await expect(check("workspaces.ownMax", subject, {})).rejects.toBeInstanceOf(PortUnavailable);
  });

  it("reads what a request needs once across several checks", async () => {
    const world = rig();
    const check = createEntitlementCheck(createEntitlementService(world));
    const request = {};

    await check("members.invite", subject, request);
    await check("audit.log", subject, request);

    expect(world.reads.versions).toBe(1);
  });
});

describe("withEntitlementChange", () => {
  it("raises the version after the change and returns what the change returned", async () => {
    const order: string[] = [];

    const result = await withEntitlementChange(
      { bump: () => (order.push("bump"), Promise.resolve(2)) },
      () => (order.push("change"), Promise.resolve("changed")),
    );

    expect(result).toBe("changed");
    expect(order).toEqual(["change", "bump"]);
  });

  it("raises no version for a change that fails", async () => {
    let bumped = false;

    await expect(
      withEntitlementChange({ bump: () => ((bumped = true), Promise.resolve(2)) }, () => Promise.reject(new Error("no"))),
    ).rejects.toThrow("no");

    expect(bumped).toBe(false);
  });

  it("fails when the version cannot be raised, so the transaction holding the change rolls it back", async () => {
    await expect(withEntitlementChange({ bump: () => Promise.resolve(undefined) }, () => Promise.resolve(1))).rejects.toBeInstanceOf(EntitlementVersionError);
  });
});
