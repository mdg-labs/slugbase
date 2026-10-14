import { describe, expect, it } from "vitest";
import { SLOT_NAMES, assertValidExtensions, isSlotName } from "../src/extensions/index.ts";

describe("assertValidExtensions", () => {
  it("accepts no extensions and distinct ids", () => {
    expect(() => {
      assertValidExtensions([]);
    }).not.toThrow();
    expect(() => {
      assertValidExtensions([{ id: "billing" }, { id: "analytics" }]);
    }).not.toThrow();
  });

  it("rejects a duplicate id and names it", () => {
    expect(() => {
      assertValidExtensions([{ id: "billing" }, { id: "billing" }]);
    }).toThrow(/"billing" is used twice/);
  });

  it("rejects an empty id", () => {
    expect(() => {
      assertValidExtensions([{ id: " " }]);
    }).toThrow(/non-empty id/);
  });

  it("rejects a slot name outside the closed set and names it", () => {
    const unknown = { "sidebar.header": () => null } as never;
    expect(() => {
      assertValidExtensions([{ id: "billing", slots: unknown }]);
    }).toThrow(/"billing" fills the unknown slot "sidebar.header"/);
  });

  it("rejects a route path that is not absolute", () => {
    expect(() => {
      assertValidExtensions([{ id: "billing", routes: [{ path: "billing", component: () => null }] }]);
    }).toThrow(/route path "billing".*must start with "\/"/);
  });

  it("rejects a route path other than the root that ends in a slash", () => {
    expect(() => {
      assertValidExtensions([{ id: "billing", routes: [{ path: "/plan/", component: () => null }] }], ["/plan"]);
    }).toThrow(/route path "\/plan\/" of the web extension "billing" must not end with "\/"/);
    expect(() => {
      assertValidExtensions([{ id: "billing", routes: [{ path: "/", component: () => null }] }]);
    }).not.toThrow();
  });

  it("rejects a route path that two extensions or the app already own", () => {
    const page = { path: "/plan", component: () => null };
    expect(() => {
      assertValidExtensions([
        { id: "a", routes: [page] },
        { id: "b", routes: [page] },
      ]);
    }).toThrow(/route path "\/plan" of the web extension "b" is already taken/);
    expect(() => {
      assertValidExtensions([{ id: "a", routes: [{ path: "/", component: () => null }] }], ["/"]);
    }).toThrow(/route path "\/" of the web extension "a" is already taken/);
  });

  it("rejects a navigation item without an absolute target or without a label", () => {
    expect(() => {
      assertValidExtensions([{ id: "a", navigation: [{ to: "plan", label: "Plan" }] }]);
    }).toThrow(/navigation target "plan".*must start with "\/"/);
    expect(() => {
      assertValidExtensions([{ id: "a", navigation: [{ to: "/plan", label: " " }] }]);
    }).toThrow(/navigation item "\/plan".*needs a label/);
  });
});

describe("the slot names", () => {
  it("are the ten of doc 03, in its order", () => {
    expect(SLOT_NAMES).toEqual([
      "sidebar.workspacePlan",
      "sidebar.footer",
      "banner.entitlement",
      "entitlement.upgradeAction",
      "accountMenu.items",
      "settings.workspace.nav",
      "settings.workspace.members.seats",
      "dashboard.top",
      "auth.footer",
      "auth.register.footer",
    ]);
  });

  it("are told from other strings", () => {
    expect(isSlotName("dashboard.top")).toBe(true);
    expect(isSlotName("dashboard.bottom")).toBe(false);
    expect(isSlotName("toString")).toBe(false);
  });
});
