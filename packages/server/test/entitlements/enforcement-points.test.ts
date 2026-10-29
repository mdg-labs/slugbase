import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITLEMENT_CATALOG, isEntitlementKey } from "@slugbase/core";
import { loadOpenApiDocument } from "@slugbase/testing/tenancy";
import { describe, expect, it } from "vitest";
import { readOperations } from "../contract/document.ts";
import { ENFORCEMENT_POINTS } from "./enforcement-points.ts";

// The inventory of the enforcement points implemented so far (doc 01 section 7.5, doc 10 T11) against the committed
// contract: an operation that declares an entitlement and has no point here, a point whose entitlement differs from the
// declaration, and a point whose test does not name its operation all fail.

const HERE = dirname(fileURLToPath(import.meta.url));
const declared = readOperations(loadOpenApiDocument()).operations.filter((operation) => operation.entitlement !== undefined);

describe("the enforcement-point inventory", () => {
  it("lists every operation of openapi.json that declares an entitlement, with the entitlement it declares", () => {
    const stage9 = ENFORCEMENT_POINTS.filter((point) => point.decidedBy === "stage-9").map((point) => [point.operationId, point.entitlement]);
    expect(stage9.sort()).toEqual(declared.map((operation) => [operation.operationId, operation.entitlement]).sort());
  });

  it("lists each operation once per entitlement, under a key of the catalog, and only a handler decides an account-scoped key", () => {
    const pairs = ENFORCEMENT_POINTS.map((point) => `${point.operationId} ${point.entitlement}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const point of ENFORCEMENT_POINTS) {
      expect(isEntitlementKey(point.entitlement), point.operationId).toBe(true);
      if (isEntitlementKey(point.entitlement) && ENTITLEMENT_CATALOG[point.entitlement].scope === "account") {
        expect(point.decidedBy, point.operationId).toBe("handler");
      }
    }
  });

  it("names, for each point, a test file that exists and mentions its operation", () => {
    for (const point of ENFORCEMENT_POINTS) {
      const file = join(HERE, point.test);
      expect(existsSync(file), `${point.test} for ${point.operationId}`).toBe(true);
      expect(readFileSync(file, "utf8"), `${point.test} for ${point.operationId}`).toContain(point.operationId);
    }
  });

  it("records the one exemption of members.invite, the owner invitation an instance admin issues, at both places a token is accepted, and no other", () => {
    const exempt = ENFORCEMENT_POINTS.filter((point) => point.exemption !== undefined).map((point) => [point.operationId, point.entitlement, point.exemption]);
    expect(exempt.sort()).toEqual([
      ["acceptInvitation", "members.invite", "the owner invitation an instance admin issues"],
      ["completeOidcSignIn", "members.invite", "the owner invitation an instance admin issues"],
    ]);
    for (const point of ENFORCEMENT_POINTS.filter((entry) => entry.exemption !== undefined)) {
      expect(readFileSync(join(HERE, point.test), "utf8"), `${point.test} for ${point.operationId}`).toContain("owner invitation");
    }
  });

  it("holds the handler-decided points to operations that declare no entitlement to stage 9: an anonymous operation whose token names the workspace, an account operation whose key is account-scoped, or a member operation whose limit is a count taken under the workspace's lock or whose entitlement follows the kind of target in the request", () => {
    const document = readOperations(loadOpenApiDocument()).operations;
    for (const point of ENFORCEMENT_POINTS.filter((entry) => entry.decidedBy === "handler")) {
      const operation = document.find((candidate) => candidate.operationId === point.operationId);
      const accountScoped = isEntitlementKey(point.entitlement) && ENTITLEMENT_CATALOG[point.entitlement].scope === "account";
      const memberDecided = point.entitlement === "bookmarks.max" || point.entitlement.startsWith("sharing.");
      expect(operation?.auth, point.operationId).toBe(accountScoped ? "account" : memberDecided ? "member" : "anonymous");
      expect(operation?.entitlement, point.operationId).toBeUndefined();
    }
  });
});
