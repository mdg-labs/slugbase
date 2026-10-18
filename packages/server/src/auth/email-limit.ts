import { normalizeEmail } from "@slugbase/core";
import type { AuthStore } from "@slugbase/db";
import { createHash } from "node:crypto";

/**
 * What the per-address limit of a credential operation counts under: the address folded by the database, as
 * the account lookup compares it, so every spelling of one account shares one bucket; hashed so the bucket
 * table never holds an email.
 */
export async function emailLimitKey(store: Pick<AuthStore, "emailKey">, email: string): Promise<string> {
  return createHash("sha256")
    .update(await store.emailKey(normalizeEmail(email)))
    .digest("hex");
}
