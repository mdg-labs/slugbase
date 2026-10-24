import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// The opaque cursor of a keyset-paginated list (doc 04 section 6.1): the sort key of the last item on the page, signed with a subkey
// derived from the server secret for this one purpose, so a client cannot forge a position. The signature also covers the scope the
// cursor was issued for (the account, and for a list with filters and sorts the filter and the sort as well), so a cursor presented
// under another scope is refused instead of followed.

const SIGNATURE_BYTES = 32;

/** One part of a sort key: a value as text, or null where the key has none (a bookmark never opened). */
export type PageCursorKeyPart = string | null;

export interface PageCursorCodec {
  /** The cursor that resumes after the item with this identifier, for this scope. */
  encode(afterId: string, scope: string): string;
  /** The identifier the cursor resumes after, or undefined when it is not one this server issued for this scope. */
  decode(cursor: string, scope: string): string | undefined;
  /** The cursor that resumes after the item with this sort key (its parts, the identifier among them), for this scope. */
  encodeKey(key: readonly PageCursorKeyPart[], scope: string): string;
  /** The sort key the cursor resumes after, or undefined when it is not one this server issued for this scope. */
  decodeKey(cursor: string, scope: string): readonly PageCursorKeyPart[] | undefined;
}

/** `purpose` binds the derived key to one list, so a cursor of one list never opens another. */
export function createPageCursorCodec(secret: string, purpose: string): PageCursorCodec {
  const key = Buffer.from(hkdfSync("sha256", secret, "", `slugbase:cursor:${purpose}`, SIGNATURE_BYTES));
  const sign = (payload: string, scope: string): Buffer => createHmac("sha256", key).update(`${scope}\n${payload}`).digest();
  const seal = (body: unknown, scope: string): string => {
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    return `${payload}.${sign(payload, scope).toString("base64url")}`;
  };
  /** The payload of a cursor whose signature holds for the scope, parsed; undefined for any other. */
  const open = (cursor: string, scope: string): unknown => {
    const parts = cursor.split(".");
    const [payload, signature] = parts;
    if (parts.length !== 2 || payload === undefined || signature === undefined) {
      return undefined;
    }
    const given = Buffer.from(signature, "base64url");
    const expected = sign(payload, scope);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    try {
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
  };
  return {
    encode: (afterId, scope) => seal({ id: afterId }, scope),
    decode(cursor, scope) {
      const parsed = open(cursor, scope);
      const id = typeof parsed === "object" && parsed !== null && "id" in parsed ? parsed.id : undefined;
      return typeof id === "string" ? id : undefined;
    },
    encodeKey: (parts, scope) => seal({ key: parts }, scope),
    decodeKey(cursor, scope) {
      const parsed = open(cursor, scope);
      const parts = typeof parsed === "object" && parsed !== null && "key" in parsed ? parsed.key : undefined;
      return Array.isArray(parts) && parts.every((part): part is PageCursorKeyPart => part === null || typeof part === "string") ? parts : undefined;
    },
  };
}
