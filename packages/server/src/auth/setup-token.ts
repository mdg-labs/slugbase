import { createHash, randomBytes } from "node:crypto";
import type { SetupStore } from "@slugbase/db";
import type { Logger } from "../create-server.ts";

// The one-time setup token of first-run setup (doc 02 section 2.2, doc 05
// section 2.2, doc 10 T4): 32 random bytes shown to the operator in the server
// log, and stored only as their SHA-256. Each start while setup is pending
// replaces the stored hash with that of a new token, so only the token printed
// last (or by the last of several servers starting together) works. A request presents the text it
// was shown, and the database compares hashes.

const TOKEN_BYTES = 32;

export interface SetupToken {
  /** What the operator is shown and a request presents. */
  readonly value: string;
  /** SHA-256 of the value, what the database stores. */
  readonly hash: Buffer;
}

/** The hash of a token as presented: the text without the whitespace a copy picks up around it. */
export function hashSetupToken(value: string): Buffer {
  return createHash("sha256").update(value.trim(), "utf8").digest();
}

/** A fresh token from the operating system's random source. */
export function newSetupToken(): SetupToken {
  const value = randomBytes(TOKEN_BYTES).toString("base64url");
  return { value, hash: hashSetupToken(value) };
}

export interface EnsureSetupTokenOptions {
  readonly store: Pick<SetupStore, "setSetupToken">;
  readonly logger: Logger;
}

/**
 * Generates a new setup token, replaces the stored hash with its hash while setup is pending, and
 * prints the token to the log once it is stored, so the token that works is always one that was
 * logged and the previous one stops working. Of several servers starting together the last to store
 * wins. Nothing is printed once setup is closed. Never rejects: when the database cannot
 * answer, no new token is stored or printed and the log says so; a token stored and printed at an
 * earlier start, if any, keeps working until a later start replaces it.
 */
export async function ensureSetupToken({ store, logger }: EnsureSetupTokenOptions): Promise<void> {
  const token = newSetupToken();
  try {
    if (await store.setSetupToken(token.hash)) {
      logger.info("First-run setup is pending. Enter this setup token on the setup screen; it replaces any earlier one and only its hash is kept", {
        setupToken: token.value,
      });
    }
  } catch (error) {
    logger.error("The first-run setup token could not be prepared; no new token was stored, and a token printed at an earlier start, if any, still works", {
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}
