import {
  ACCOUNT_LIMIT_ENTITLEMENTS,
  ENTITLEMENT_CATALOG,
  FLAG_ENTITLEMENTS,
  WORKSPACE_LIMIT_ENTITLEMENTS,
  createEntitlementCheck,
  createEntitlementService,
  type EntitlementKey,
} from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { createFullEntitlementSource } from "../src/index.ts";

// The Community Edition's source (doc 01 section 7.5): every flag granted, every limit unlimited, for any
// workspace and any account, and no upgrade path (T11: with the CE source nothing is limited).

const WORKSPACES = ["0192f3a0-aaaa-7000-8000-000000000001", "0192f3a0-bbbb-7000-8000-000000000002"];
const ACCOUNTS = ["0192f3a0-cccc-7000-8000-000000000003", "0192f3a0-dddd-7000-8000-000000000004"];

describe("createFullEntitlementSource", () => {
  it("is available and grants every flag of the catalog", async () => {
    const source = createFullEntitlementSource();
    expect(source.available).toBe(true);

    for (const workspaceId of WORKSPACES) {
      const { values } = await source.forWorkspace(workspaceId);
      for (const key of FLAG_ENTITLEMENTS) {
        expect(values[key], key).toBe(true);
      }
    }
  });

  it("returns unlimited for every limit, of a workspace and of an account", async () => {
    const source = createFullEntitlementSource();

    for (const workspaceId of WORKSPACES) {
      const { values } = await source.forWorkspace(workspaceId);
      for (const key of WORKSPACE_LIMIT_ENTITLEMENTS) {
        expect(values[key], key).toBe("unlimited");
      }
    }
    for (const accountId of ACCOUNTS) {
      const values = await source.forAccount(accountId);
      for (const key of ACCOUNT_LIMIT_ENTITLEMENTS) {
        expect(values[key], key).toBe("unlimited");
      }
    }
  });

  it("holds exactly the keys of the catalog, no more and no fewer", async () => {
    const source = createFullEntitlementSource();
    const keys = [...Object.keys((await source.forWorkspace(WORKSPACES[0] ?? "")).values), ...Object.keys(await source.forAccount(ACCOUNTS[0] ?? ""))];

    expect(keys.sort()).toEqual(Object.keys(ENTITLEMENT_CATALOG).sort());
  });

  it("offers no upgrade path", async () => {
    expect((await createFullEntitlementSource().forWorkspace(WORKSPACES[0] ?? "")).upgradeAvailable).toBe(false);
  });

  it("cannot be changed through the values it returns", async () => {
    const source = createFullEntitlementSource();
    const grant = await source.forWorkspace(WORKSPACES[0] ?? "");

    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.values)).toBe(true);
    expect(Object.isFrozen(await source.forAccount(ACCOUNTS[0] ?? ""))).toBe(true);
  });

  it("holds every entitlement of the catalog for the engine, whichever workspace and account ask", async () => {
    const check = createEntitlementCheck(createEntitlementService({ source: createFullEntitlementSource(), versions: { read: () => Promise.resolve(1) } }));

    for (const key of Object.keys(ENTITLEMENT_CATALOG) as EntitlementKey[]) {
      for (const accountId of ACCOUNTS) {
        for (const workspaceId of WORKSPACES) {
          expect(await check(key, { accountId, workspaceId }, {}), `${key} for ${accountId} in ${workspaceId}`).toBe(true);
        }
      }
    }
  });
});
