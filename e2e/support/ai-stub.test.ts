import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { COMPLETIONS_PATH, REQUESTS_PATH, answerFor, createAiStub } from "./ai-stub/stub.ts";

const stub = createAiStub();
let base = "";

before(async () => {
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((stub.server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => stub.server.close(() => {
    resolve();
  }));
});

function completion(url: string, tags: readonly string[] = []): string {
  const data = JSON.stringify({ url, language: "en", title: null, description: null, existing_tags: tags });
  return JSON.stringify({
    model: "stub-model",
    messages: [
      { role: "system", content: "You suggest details for a bookmark." },
      { role: "user", content: `Suggest the details.\n<bookmark_data>\n${data}\n</bookmark_data>` },
    ],
    response_format: { type: "json_object" },
  });
}

void describe("the AI stub of the e2e stack", () => {
  void it("answers a chat completion with a suggestion made from the address and the member's first tag, and keeps what it received", async () => {
    const response = await fetch(`${base}${COMPLETIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "secret=1" },
      body: completion("https://ada-1.invalid/page", ["reading", "work"]),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    assert.deepEqual(JSON.parse(body.choices[0]?.message.content ?? ""), {
      title: "Stub title for ada-1.invalid",
      slug: "ada-1",
      tags: ["reading", "stub-tag"],
      confidence: 0.9,
    });
    const listed = (await (await fetch(`${base}${REQUESTS_PATH}`)).json()) as { method: string; path: string; headers: string[]; body: string }[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.path, COMPLETIONS_PATH);
    assert.ok(listed[0].headers.includes("cookie"), "the names of the headers are kept");
    assert.ok(!JSON.stringify(listed).includes("secret=1"), "their values are not");
  });

  void it("clears what it received, answers 500 for a host that starts with fail- and 404 for any other path", async () => {
    assert.equal((await fetch(`${base}${REQUESTS_PATH}`, { method: "DELETE" })).status, 204);
    assert.deepEqual(await (await fetch(`${base}${REQUESTS_PATH}`)).json(), []);

    const failed = await fetch(`${base}${COMPLETIONS_PATH}`, { method: "POST", body: completion("https://fail-1.invalid/") });
    assert.equal(failed.status, 500);
    assert.equal((await fetch(`${base}/v1/models`)).status, 404);
    assert.equal(((await (await fetch(`${base}${REQUESTS_PATH}`)).json()) as unknown[]).length, 1);
  });

  void it("suggests only the stub's own tag where the request names none", () => {
    assert.deepEqual((JSON.parse(answerFor(undefined)) as { tags: string[] }).tags, ["stub-tag"]);
  });
});
