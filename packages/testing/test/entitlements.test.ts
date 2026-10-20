import { ENTITLEMENT_CATALOG, createEntitlementCheck, createEntitlementService, type EntitlementKey } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { LimitedEntitlementSource } from "../src/index.ts";

const WORKSPACE = "0192f3a0-aaaa-7000-8000-000000000001";
const ACCOUNT = "0192f3a0-cccc-7000-8000-000000000003";
const KEYS = Object.keys(ENTITLEMENT_CATALOG) as EntitlementKey[];

describe("LimitedEntitlementSource", () => {
  it("starts as the full, unlimited source", async () => {
    const source = new LimitedEntitlementSource();
    const check = createEntitlementCheck(createEntitlementService({ source, versions: source }));

    for (const key of KEYS) {
      expect(await check(key, { accountId: ACCOUNT, workspaceId: WORKSPACE }, {}), key).toBe(true);
    }
    expect(source.version).toBe(1);
  });

  it.each(KEYS)("denies %s and grants it again, moving the version each time", async (key) => {
    const source = new LimitedEntitlementSource();
    const check = createEntitlementCheck(createEntitlementService({ source, versions: source }));
    const subject = { accountId: ACCOUNT, workspaceId: WORKSPACE };

    source.deny(key);
    const denied = await check(key, subject, {});
    source.grant(key, ENTITLEMENT_CATALOG[key].type === "flag" ? true : 5);
    const granted = await check(key, subject, {});

    expect([denied, granted]).toEqual([false, true]);
    expect(source.version).toBe(3);
  });

  it("refuses a value of the wrong kind for a key", () => {
    const source = new LimitedEntitlementSource();

    expect(() => source.grant("seats.max", true)).toThrow("seats.max is a limit");
    expect(() => source.grant("audit.log", 3)).toThrow("audit.log is a flag");
    expect(source.version).toBe(1);
  });

  it("changes its version on demand, and records what the engine read", async () => {
    const source = new LimitedEntitlementSource();
    const service = createEntitlementService({ source, versions: source });

    await service.forRequest({}, ACCOUNT).forWorkspace(WORKSPACE);
    await service.forRequest({}, ACCOUNT).forWorkspace(WORKSPACE);
    source.bump();
    await service.forRequest({}, ACCOUNT).forWorkspace(WORKSPACE);

    expect(source.reads.workspaces).toEqual([WORKSPACE, WORKSPACE]);
  });
});
