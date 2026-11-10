import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foreignOrigins } from "./foreign-requests.ts";

void describe("the origins of the requests of a page", () => {
  const origin = "https://127.0.0.1:20443";

  void it("accepts requests to the app's origin and addresses that are no request to a network", () => {
    assert.deepEqual(foreignOrigins([`${origin}/`, `${origin}/assets/app.js`, "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "blob:https://127.0.0.1:20443/1b2c", "about:blank"], origin), []);
  });

  void it("reports each other origin once, whatever its scheme or port", () => {
    assert.deepEqual(
      foreignOrigins([`${origin}/`, "https://fonts.example.com/a.woff2", "https://fonts.example.com/b.woff2", "http://127.0.0.1:20443/", "https://127.0.0.1:20444/x"], origin),
      ["http://127.0.0.1:20443", "https://127.0.0.1:20444", "https://fonts.example.com"],
    );
  });
});
