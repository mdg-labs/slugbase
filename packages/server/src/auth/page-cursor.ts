import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

// The opaque cursor of a keyset-paginated list (doc 04 section 6.1): the sort
// key of the last item on the page, signed with a subkey derived from the
// server secret for this one purpose, so a client cannot forge a position. The
// signature also covers the scope the cursor was issued for (here the account),
// so a cursor presented under another scope is refused instead of followed.

const SIGNATURE_BYTES = 32;

export interface PageCursorCodec {
  /** The cursor that resumes after the item with this identifier, for this scope. */
  encode(afterId: string, scope: string): string;
  /** The identifier the cursor resumes after, or undefined when it is not one this server issued for this scope. */
  decode(cursor: string, scope: string): string | undefined;
}

/** `purpose` binds the derived key to one list, so a cursor of one list never opens another. */
export function createPageCursorCodec(secret: string, purpose: string): PageCursorCodec {
  const key = Buffer.from(hkdfSync("sha256", secret, "", `slugbase:cursor:${purpose}`, SIGNATURE_BYTES));
  const sign = (payload: string, scope: string): Buffer => createHmac("sha256", key).update(`${scope}\n${payload}`).digest();
  return {
    encode(afterId, scope) {
      const payload = Buffer.from(JSON.stringify({ id: afterId })).toString("base64url");
      return `${payload}.${sign(payload, scope).toString("base64url")}`;
    },
    decode(cursor, scope) {
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
        const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        const id = typeof parsed === "object" && parsed !== null && "id" in parsed ? parsed.id : undefined;
        return typeof id === "string" ? id : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
