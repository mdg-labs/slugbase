import { AUDIT_EVENT_ACTIONS, AUDIT_EVENT_CATEGORIES } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { actionLabel, categoryLabel, entityLabel, metadataLabel, targetNameOf } from "../src/audit/audit-labels.ts";
import de from "../src/i18n/locales/de.json" with { type: "json" };
import en from "../src/i18n/locales/en.json" with { type: "json" };

// The labels of the audit log (doc 03 section 11.9, D19): every action of the catalog and every category has a label in both
// languages. The failure scenario is an action added to the catalog without a label, which the log would then show as its raw name.

const CATALOGS = { en, de } as const;

/** The message at a dotted key, following the nesting of the catalog; undefined where the path does not end in a string. */
function messageAt(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

describe.each(Object.entries(CATALOGS))("the %s catalog", (language, catalog) => {
  it.each(AUDIT_EVENT_ACTIONS)("labels the action %s", (action) => {
    expect(messageAt(catalog, `audit.actions.${action}`), `${language}: audit.actions.${action}`).toBeDefined();
  });

  it.each(AUDIT_EVENT_CATEGORIES)("labels the category %s", (category) => {
    expect(messageAt(catalog, `audit.categories.${category}`), `${language}: audit.categories.${category}`).toBeDefined();
  });
});

// The metadata fields of the catalog in `packages/core/src/audit/catalog.ts`, which the contract does not list; the web does not import the core package, so a field added there is added here.
const METADATA_KEYS = [
  "name", "from", "to", "setting", "demoteSelf", "content", "transferTo", "role", "count", "targetKind", "targetId", "targetName",
  "bookmarks", "folders", "tags", "shared", "created", "skipped", "failed", "slugsDropped", "foldersCreated", "tagsCreated",
] as const;

describe.each(Object.entries(CATALOGS))("the %s catalog", (language, catalog) => {
  it.each(METADATA_KEYS)("labels the metadata field %s", (key) => {
    expect(messageAt(catalog, `audit.metadata.${key}`), `${language}: audit.metadata.${key}`).toBeDefined();
  });
});

describe("the label functions", () => {
  // A translate function that answers with the key it was given, so that a label that is read from the wrong key shows.
  const t = ((key: string) => key) as Parameters<typeof actionLabel>[0];

  it("read the key of the catalog for every action and category", () => {
    for (const action of AUDIT_EVENT_ACTIONS) {
      expect(actionLabel(t, action)).toBe(`audit.actions.${action}`);
    }
    for (const category of AUDIT_EVENT_CATEGORIES) {
      expect(categoryLabel(t, category)).toBe(`audit.categories.${category}`);
    }
  });

  it("read the key of the catalog for every metadata field, and show the recorded key of one this version does not know", () => {
    for (const key of METADATA_KEYS) {
      expect(metadataLabel(t, key)).toBe(`audit.metadata.${key}`);
    }
    expect(metadataLabel(t, "newField")).toBe("newField");
    expect(metadataLabel(t, "constructor")).toBe("constructor");
  });

  it("show the recorded name of an action or a kind of thing this version does not know", () => {
    expect(actionLabel(t, "retired.action")).toBe("retired.action");
    expect(entityLabel(t, "widget")).toBe("widget");
    expect(actionLabel(t, "constructor")).toBe("constructor");
    expect(entityLabel(t, "toString")).toBe("toString");
  });

  it("take the name of a target from the field that holds a name, and a rename's new name, but never a role", () => {
    expect(targetNameOf({ action: "team.created", metadata: { name: "Platform" } })).toBe("Platform");
    expect(targetNameOf({ action: "share.granted", metadata: { targetKind: "member", targetName: "Grace" } })).toBe("Grace");
    expect(targetNameOf({ action: "workspace.renamed", metadata: { from: "Old", to: "New" } })).toBe("New");
    expect(targetNameOf({ action: "team.updated", metadata: { from: "Old", to: "New" } })).toBe("New");
    expect(targetNameOf({ action: "member.role_changed", metadata: { from: "member", to: "admin" } })).toBeUndefined();
    expect(targetNameOf({ action: "team.created", metadata: { name: "" } })).toBeUndefined();
    expect(targetNameOf({ action: "workspace.deletion_requested", metadata: {} })).toBeUndefined();
  });
});
