import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The import-and-export journey (tests/import-export.spec.ts) checks, previews, imports and exports a dozen times from one client address, one account
// and one hour (doc 04 section 7: the `bulk` bucket, 20 an hour by default). The e2e stack lifts both limits for itself, in the override file that
// only e2e/with-stack.sh merges; the files an operator runs keep the default.

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const KEYS = ["RATE_LIMIT_BULK_IP", "RATE_LIMIT_BULK_ACCOUNT"] as const;

void describe("the bulk budget of the e2e stack", () => {
  const override = read("compose.e2e.yml");

  void it("is raised for the server and the worker of the e2e stack, to a count that no journey comes near", () => {
    const anchored = /^ {4}environment: &e2e-environment\n((?: {6}.*\n)+)/m.exec(override);
    assert.ok(anchored?.[1], "the server's environment is the anchor e2e-environment");
    for (const key of KEYS) {
      const line = new RegExp(`^ {6}${key}: (\\d+)/hour$`, "m").exec(anchored[1]);
      assert.ok(line?.[1], `${key} is set in the environment the server gets`);
      assert.ok(Number(line[1]) >= 1000, `${key} allows at least 1000 an hour`);
    }
    assert.match(override, /^ {2}slugbase-worker:\n {4}environment: \*e2e-environment$/m);
  });

  void it("is set nowhere an operator or the image looks: compose.yml passes the keys through, .env.example documents 20/hour", () => {
    for (const key of KEYS) {
      assert.match(read("compose.yml"), new RegExp(`^ {2}${key}:\\s*$`, "m"));
      assert.match(read(".env.example"), new RegExp(`^${key}=20/hour$`, "m"));
      assert.doesNotMatch(read("compose.pg17.yml"), new RegExp(key));
    }
  });
});
