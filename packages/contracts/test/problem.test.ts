import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { omit } from "./omit.ts";
import { PROBLEM_CATALOG, ProblemSchema, problemStatus } from "../src/problem.ts";

const doc04 = readFileSync(new URL("../../../docs/internal/04-api.md", import.meta.url), "utf8");

function documentedCodes(): { status: number; code: string }[] {
  const section = doc04.slice(doc04.indexOf("### 3.2 Code catalog"), doc04.indexOf("Field codes inside"));
  return [...section.matchAll(/^\| (\d{3}) \| `([a-z_]+)` \|/gm)].map((match) => ({
    status: Number(match[1]),
    code: match[2] ?? "",
  }));
}

describe("ProblemCode catalog", () => {
  it("lists each code once", () => {
    const codes = PROBLEM_CATALOG.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("maps every code to exactly one status", () => {
    for (const entry of PROBLEM_CATALOG) {
      expect(problemStatus(entry.code)).toBe(entry.status);
    }
  });

  it("holds every code and status of doc 04 section 3.2", () => {
    const documented = documentedCodes();
    expect(documented.length).toBeGreaterThan(30);
    for (const row of documented) {
      expect(PROBLEM_CATALOG).toContainEqual(row);
    }
  });

  it("adds only the three 503 sub-codes the table names in prose", () => {
    const documented = new Set(documentedCodes().map((row) => row.code));
    const extra = PROBLEM_CATALOG.filter((entry) => !documented.has(entry.code)).map((entry) => entry.code);
    expect(extra).toEqual(["mail_unavailable", "ai_unavailable", "billing_unavailable"]);
  });
});

describe("Problem", () => {
  const problem = {
    type: "https://slugbase.app/problems/slug_taken",
    title: "Slug already in use",
    status: 409,
    code: "slug_taken",
    detail: "You already use the slug mail in this workspace.",
    requestId: "01J9",
    errors: [{ path: "slug", code: "slug_taken" }],
  };

  it("accepts the document of doc 04 section 3.1", () => {
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it("keeps the extra members some codes carry", () => {
    const withLimit = { ...problem, code: "bookmark_limit_reached", status: 422, limit: 100, used: 100 };
    expect(ProblemSchema.parse(withLimit)).toMatchObject({ limit: 100, used: 100 });
  });

  it("rejects a document missing a required member or with an unknown code", () => {
    const withoutRequestId = omit(problem, "requestId");
    expect(ProblemSchema.safeParse(withoutRequestId).success).toBe(false);
    expect(ProblemSchema.safeParse({ ...problem, code: "made_up" }).success).toBe(false);
  });
});
