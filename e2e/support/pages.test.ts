import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGES, pageProblems, readJourney, routeFiles, type Coverage } from "./pages.ts";

// The pages of the app and the journeys that scan them (doc 08 section 5.2). The accessibility check runs on the pages a journey visits,
// so a route nobody visits is a page nobody checks: the table in pages.ts has to name every route file, and these cases keep that true
// and show the guard fails when it is not.

const FILES = ["_app.tsx", "_app/bookmarks.tsx", "login.tsx", "go.$slug.tsx"];
const TABLE: Readonly<Record<string, Coverage>> = {
  "_app.tsx": { exempt: "a layout" },
  "_app/bookmarks.tsx": { spec: "bookmarks.spec.ts", visits: '"/bookmarks"' },
  "login.tsx": { spec: "axe.spec.ts", visits: '"/login"' },
  "go.$slug.tsx": { exempt: "a redirect" },
};
const JOURNEYS: Readonly<Record<string, string>> = {
  "bookmarks.spec.ts": 'await app.visit("/bookmarks", heading);',
  "axe.spec.ts": 'await app.visit("/login", card);',
};
const read = (spec: string): string | undefined => JOURNEYS[spec];

void describe("the pages of the app and the journeys that scan them", () => {
  void it("names every route file under packages/web/src/routes/, with a journey that visits it or a reason it is exempt", () => {
    const files = routeFiles();
    assert.ok(files.length > 20, "the route files were found");
    assert.deepEqual(pageProblems(files, PAGES, readJourney), []);
  });

  void it("does not list the files the router ignores", () => {
    const files = routeFiles();
    assert.ok(files.includes("_app/settings/workspace/members.tsx"));
    assert.deepEqual(
      files.filter((file) => file.split("/").some((part) => part.startsWith("-"))),
      [],
    );
  });

  void it("passes a table that covers every route file", () => {
    assert.deepEqual(pageProblems(FILES, TABLE, read), []);
  });

  void it("fails on a route file added without an entry, and names it", () => {
    const problems = pageProblems([...FILES, "_app/reports.tsx"], TABLE, read);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^_app\/reports\.tsx is neither visited by a journey nor exempt/);
  });

  void it("fails on an entry whose route file is gone", () => {
    const problems = pageProblems(FILES.filter((file) => file !== "login.tsx"), TABLE, read);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^login\.tsx is in PAGES but is not a route file/);
  });

  void it("fails on an exemption without a reason", () => {
    const problems = pageProblems(FILES, { ...TABLE, "_app.tsx": { exempt: "  " } }, read);
    assert.deepEqual(problems, ["_app.tsx is exempt without a reason"]);
  });

  void it("fails when the journey it names does not exist or does not visit the page", () => {
    const missing = pageProblems(FILES, { ...TABLE, "login.tsx": { spec: "gone.spec.ts", visits: '"/login"' } }, read);
    assert.match(missing.join("\n"), /^login\.tsx is visited by gone\.spec\.ts, which does not exist/);
    const elsewhere = pageProblems(FILES, { ...TABLE, "login.tsx": { spec: "bookmarks.spec.ts", visits: '"/login"' } }, read);
    assert.match(elsewhere.join("\n"), /^login\.tsx is visited by bookmarks\.spec\.ts, which does not hold "\\"\/login\\""/);
    const nothing = pageProblems(FILES, { ...TABLE, "login.tsx": { spec: "axe.spec.ts", visits: "" } }, read);
    assert.equal(nothing.length, 1);
  });
});
