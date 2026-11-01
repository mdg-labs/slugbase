import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { COMPLETIONS_PATH } from "./ai-stub/stub.ts";

// The AI endpoint of the e2e stack is a stand-in that only e2e/with-stack.sh starts (e2e/compose.ai.yml). The files an operator runs
// configure none, and the server is the only service that is pointed at it.

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

void describe("the AI endpoint of the e2e stack", () => {
  const overlay = read("e2e/compose.ai.yml");
  const server = /^ {2}slugbase:\n((?: {4}.*\n| *\n)+)/m.exec(overlay)?.[1] ?? "";

  void it("is reached by the name of its service, over plain http, on the one host the operator's allowance names", () => {
    const base = /^ {6}AI_BASE_URL: (\S+)$/m.exec(server)?.[1];
    const allowed = /^ {6}AI_ALLOWED_PRIVATE_HOST: (\S+)$/m.exec(server)?.[1];
    assert.ok(base !== undefined && allowed !== undefined, "the server gets the endpoint and the allowance");
    assert.equal(new URL(base).protocol, "http:");
    assert.equal(new URL(base).hostname, allowed);
    assert.match(overlay, new RegExp(`^ {2}${allowed}:$`, "m"), "the host is a service of the overlay");
    assert.equal(`${new URL(base).pathname}/chat/completions`, COMPLETIONS_PATH);
  });

  void it("is given to the server alone, and carries no credential", () => {
    assert.doesNotMatch(overlay, /slugbase-worker/);
    assert.doesNotMatch(overlay, /^ +AI_API_KEY:/m);
    assert.doesNotMatch(read("compose.e2e.yml"), /AI_/);
  });

  void it("is merged by with-stack.sh and by nothing an operator runs", () => {
    assert.match(read("e2e/with-stack.sh"), /SMOKE_EXTRA_COMPOSE_FILES="\$root\/compose\.e2e\.yml \$root\/e2e\/compose\.ai\.yml"/);
    for (const file of ["compose.yml", "compose.pg17.yml", ".env.example"]) {
      assert.doesNotMatch(read(file), /ai-stub|stub-model|Example AI/, `${file} knows nothing of the stub`);
    }
    assert.match(read("compose.yml"), /^ {6}AI_BASE_URL:\s*$/m, "compose.yml passes the key through with no value");
  });
});
