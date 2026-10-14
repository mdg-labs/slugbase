import { describe, expect, it } from "vitest";
import { createPageCursorCodec } from "../../src/auth/page-cursor.ts";

const SECRET = "a-secret-of-the-test-run-at-least-32-characters";
const ID = "0192f3a0-0000-7000-8000-0000000000a1";

describe("the page cursor codec", () => {
  const codec = createPageCursorCodec(SECRET, "sessions");

  it("gives back the identifier it was issued for, for the scope it was issued for", () => {
    expect(codec.decode(codec.encode(ID, "account-a"), "account-a")).toBe(ID);
  });

  it("refuses the cursor under another scope, another secret or another purpose", () => {
    const cursor = codec.encode(ID, "account-a");
    expect(codec.decode(cursor, "account-b")).toBeUndefined();
    expect(createPageCursorCodec("another-secret-of-the-test-run-at-least-32-chars", "sessions").decode(cursor, "account-a")).toBeUndefined();
    expect(createPageCursorCodec(SECRET, "bookmarks").decode(cursor, "account-a")).toBeUndefined();
  });

  it("refuses a cursor whose payload or signature was changed, or that is not in the shape it issues", () => {
    const [payload = "", signature = ""] = codec.encode(ID, "account-a").split(".");
    const other = Buffer.from(JSON.stringify({ id: "0192f3a0-0000-7000-8000-0000000000a2" })).toString("base64url");
    for (const cursor of ["", ".", "x", payload, `${payload}.`, `.${signature}`, `${other}.${signature}`, `${payload}.${signature}.${signature}`, `${payload}.${signature}A`]) {
      expect(codec.decode(cursor, "account-a"), cursor).toBeUndefined();
    }
  });
});
