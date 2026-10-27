import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESTINATION_HEADING, startDestination } from "./destination.ts";

void describe("the destination of the /go journeys", () => {
  void it("answers every path with an accessible page that names the path, and records what it was asked for", async () => {
    const destination = await startDestination();
    try {
      assert.match(destination.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(destination.url("/arrived/abc?x=1"));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
      const html = await response.text();
      assert.match(html, /<html lang="en">/);
      assert.match(html, new RegExp(`<h1>${DESTINATION_HEADING}</h1>`));
      assert.ok(html.includes("<p>/arrived/abc?x=1</p>"));
      assert.deepEqual(destination.requests(), ["/arrived/abc?x=1"]);
    } finally {
      await destination.close();
    }
  });

  void it("shows a path with markup in it as text", async () => {
    const destination = await startDestination();
    try {
      const html = await (await fetch(destination.url("/%3Cscript%3E"))).text();
      assert.ok(!html.includes("<script>"));
      assert.ok(html.includes("<p>/%3Cscript%3E</p>"));
    } finally {
      await destination.close();
    }
  });

  void it("stops listening when it is closed", async () => {
    const destination = await startDestination();
    await destination.close();
    await assert.rejects(fetch(destination.url("/")));
  });
});
