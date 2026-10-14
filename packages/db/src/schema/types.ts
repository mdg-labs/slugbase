import { customType } from "drizzle-orm/pg-core";

// Column types of doc 05 section 1 that Drizzle has no builder for.

/** `citext`: text compared case-insensitively (emails, slugs, names). */
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

/** `bytea`: the SHA-256 digests of tokens and the ciphertext of secrets. */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
