import { describe, expect, it } from "vitest";
import { REGISTRATION_ACKNOWLEDGEMENTS_MAX } from "@slugbase/contracts";
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

  it("accepts acknowledgements across extensions up to the number one request carries", () => {
    const entries = Array.from({ length: REGISTRATION_ACKNOWLEDGEMENTS_MAX }, (_, index) => ({ id: `doc-${String(index)}`, version: "2026-01", label: "Label" }));
    expect(() => {
      assertValidExtensions([
        { id: "one", acknowledgements: entries.slice(0, 3) },
        { id: "two", acknowledgements: entries.slice(3) },
      ]);
    }).not.toThrow();
  });

  it.each([
    ["an id with an upper-case letter", { id: "Terms", version: "1" }, /"Terms" of the web extension "legal" has an invalid id/],
    ["an empty id", { id: "", version: "1" }, /has an invalid id/],
    ["an id longer than 32 characters", { id: "a".repeat(33), version: "1" }, /has an invalid id/],
    ["an empty version", { id: "terms", version: "" }, /"terms" of the web extension "legal" has an invalid version/],
    ["a version longer than 32 characters", { id: "terms", version: "v".repeat(33) }, /has an invalid version/],
    ["a version with a control character", { id: "terms", version: "1\n2" }, /has an invalid version/],
  ])("rejects an acknowledgement with %s", (_name, entry, message) => {
    expect(() => {
      assertValidExtensions([{ id: "legal", acknowledgements: [{ ...entry, label: "Label" }] }]);
    }).toThrow(message);
  });

  it("rejects an acknowledgement id declared twice, within one extension or across two", () => {
    expect(() => {
      assertValidExtensions([{ id: "legal", acknowledgements: [{ id: "terms", version: "1", label: "A" }, { id: "terms", version: "2", label: "B" }] }]);
    }).toThrow(/acknowledgement id "terms" of the web extension "legal" is used twice/);
    expect(() => {
      assertValidExtensions([
        { id: "legal", acknowledgements: [{ id: "terms", version: "1", label: "A" }] },
        { id: "other", acknowledgements: [{ id: "terms", version: "1", label: "A" }] },
      ]);
    }).toThrow(/acknowledgement id "terms" of the web extension "other" is used twice/);
  });

  it("rejects more acknowledgements in total than one request carries", () => {
    const entries = Array.from({ length: REGISTRATION_ACKNOWLEDGEMENTS_MAX + 1 }, (_, index) => ({ id: `doc-${String(index)}`, version: "1", label: "Label" }));
    expect(() => {
      assertValidExtensions([
        { id: "one", acknowledgements: entries.slice(0, 5) },
        { id: "two", acknowledgements: entries.slice(5) },
      ]);
    }).toThrow(new RegExp(`${String(REGISTRATION_ACKNOWLEDGEMENTS_MAX + 1)} acknowledgements; at most ${String(REGISTRATION_ACKNOWLEDGEMENTS_MAX)}`));
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
