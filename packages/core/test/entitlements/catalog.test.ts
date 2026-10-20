import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENTITLEMENT_CATALOG, isEntitlementKey } from "../../src/index.ts";

// The catalog is the table of doc 01 section 7.5: the keys, their scope and their type, and nothing else.
const DOC = readFileSync(new URL("../../../../docs/internal/01-architecture.md", import.meta.url), "utf8");

interface Row {
  readonly key: string;
  readonly scope: string;
  readonly type: string;
}

function tableOfSection75(): Row[] {
  const section = DOC.slice(DOC.indexOf("### 7.5 The entitlement catalog"));
  const rows: Row[] = [];
  for (const line of section.split("\n").slice(1)) {
    if (line.startsWith("**Evaluation.**")) {
      break;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    const key = /^`([a-z]+\.[A-Za-z]+)`$/.exec(cells[1] ?? "")?.[1];
    if (key !== undefined) {
      rows.push({ key, scope: (cells[2] ?? "").replaceAll("*", ""), type: (cells[3] ?? "").startsWith("number") ? "limit" : "flag" });
    }
  }
  return rows;
}

describe("the entitlement catalog", () => {
  it("equals the table of doc 01 section 7.5, key by key with its scope and type", () => {
    const table = tableOfSection75();
    expect(table).toHaveLength(9);
    expect(Object.entries(ENTITLEMENT_CATALOG).map(([key, { scope, type }]) => ({ key, scope, type }))).toEqual(table);
  });

  it("names the nine keys of the table", () => {
    expect(Object.keys(ENTITLEMENT_CATALOG).sort()).toEqual(
      [
        "ai.suggestions",
        "audit.log",
        "bookmarks.max",
        "members.invite",
        "seats.max",
        "sharing.members",
        "sharing.teams",
        "teams.manage",
        "workspaces.ownMax",
      ].sort(),
    );
  });

  it("scopes only workspaces.ownMax to the account", () => {
    expect(Object.entries(ENTITLEMENT_CATALOG).filter(([, { scope }]) => scope === "account").map(([key]) => key)).toEqual(["workspaces.ownMax"]);
  });

  it("holds none of the features that are not entitlements on any edition", () => {
    for (const key of ["tokens.max", "folders.max", "tags.max", "slugs.max", "go", "palette", "import", "export", "mfa", "oidc", "api.tokens", "folders", "tags", "slugs"]) {
      expect(isEntitlementKey(key), key).toBe(false);
    }
    expect(isEntitlementKey("toString")).toBe(false);
    expect(isEntitlementKey("__proto__")).toBe(false);
  });
});
