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

describe("the page cursor codec with a sort key", () => {
  const codec = createPageCursorCodec(SECRET, "bookmarks");
  const KEY = ["2026-03-01 10:00:09.123456+00", ID] as const;

  it("gives back the parts of the key it was issued for, a null part included, for the scope it was issued for", () => {
    expect(codec.decodeKey(codec.encodeKey(KEY, "scope-a"), "scope-a")).toEqual(KEY);
    expect(codec.decodeKey(codec.encodeKey([null, ID], "scope-a"), "scope-a")).toEqual([null, ID]);
  });

  it("refuses the cursor under another scope, another secret or another purpose", () => {
    const cursor = codec.encodeKey(KEY, "scope-a");
    expect(codec.decodeKey(cursor, "scope-b")).toBeUndefined();
    expect(createPageCursorCodec("another-secret-of-the-test-run-at-least-32-chars", "bookmarks").decodeKey(cursor, "scope-a")).toBeUndefined();
    expect(createPageCursorCodec(SECRET, "members").decodeKey(cursor, "scope-a")).toBeUndefined();
  });

  it("refuses a cursor with one byte of its payload flipped, or whose signature was cut or extended", () => {
    const [payload = "", signature = ""] = codec.encodeKey(KEY, "scope-a").split(".");
    const bytes = Buffer.from(payload, "base64url");
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0x01;
    const flipped = bytes.toString("base64url");
    for (const cursor of [`${flipped}.${signature}`, `${payload}.${signature.slice(1)}`, `${payload}.${signature}A`, payload]) {
      expect(codec.decodeKey(cursor, "scope-a"), cursor).toBeUndefined();
    }
  });

  it("does not open a cursor of the other shape: an identifier-only cursor is no key and a key cursor is no identifier", () => {
    expect(codec.decodeKey(codec.encode(ID, "scope-a"), "scope-a")).toBeUndefined();
    expect(codec.decode(codec.encodeKey(KEY, "scope-a"), "scope-a")).toBeUndefined();
  });
});

