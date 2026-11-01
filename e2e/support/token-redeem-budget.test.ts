import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The journeys redeem invitation tokens from one client address (doc 04 section 7). The e2e stack lifts that limit for itself, in the
// override file that only e2e/with-stack.sh merges; the files an operator runs keep the default of 10 an hour.

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const KEY = "RATE_LIMIT_TOKEN_REDEEM_IP";

void describe("the invitation-accept budget of the e2e stack", () => {
  const override = read("compose.e2e.yml");

  void it("is raised for the server and the worker of the e2e stack, to a count that no journey comes near", () => {
    const anchored = /^ {4}environment: &e2e-environment\n((?: {6}.*\n)+)/m.exec(override);
    assert.ok(anchored?.[1], "the server's environment is the anchor e2e-environment");
    const line = new RegExp(`^ {6}${KEY}: (\\d+)/hour$`, "m").exec(anchored[1]);
    assert.ok(line?.[1], `${KEY} is set in the environment the server gets`);
    assert.ok(Number(line[1]) >= 1000, `${KEY} allows at least 1000 an hour`);
    assert.match(override, /^ {2}slugbase-worker:\n {4}environment: \*e2e-environment$/m);
  });

  void it("is set nowhere an operator or the image looks: compose.yml passes the key through, .env.example documents 10/hour", () => {
    assert.match(read("compose.yml"), new RegExp(`^ {2}${KEY}:\\s*$`, "m"));
    assert.match(read(".env.example"), new RegExp(`^${KEY}=10/hour$`, "m"));
    assert.doesNotMatch(read("compose.pg17.yml"), new RegExp(KEY));
  });
});
