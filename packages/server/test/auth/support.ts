import { createHash } from "node:crypto";
import { createAuthStore, type AuthStore } from "@slugbase/db";
import type { TestDatabase } from "@slugbase/testing/db";
import { hashPassword } from "../../src/auth/password.ts";
import { appUrl } from "../contract/support.ts";

// Fixtures for the sign-in tests, written the way the test database allows:
// `accounts` has forced row-level security with the own-row policy, so the table
// owner inserts a row by naming the account in the setting; `sessions` has no
// policy at all, so the owner reads and changes it as slugbase_system (the owner
// is a member of that role, doc 05 section 3.1), which stands for the system
// operations here.

let accountNumber = 0;

export interface SeededAccount {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export interface SeedOptions {
  readonly email?: string;
  readonly password?: string | null;
  readonly disabled?: boolean;
}

export function storeFor(database: TestDatabase): AuthStore {
  return createAuthStore({ url: appUrl(database), poolSize: 4 });
}

/** Creates an account whose password is hashed with the production parameters. */
export async function seedAccount(database: TestDatabase, options: SeedOptions = {}): Promise<SeededAccount> {
  accountNumber += 1;
  const id = `0192f3a0-bbbb-7000-8000-${accountNumber.toString(16).padStart(12, "0")}`;
  const email = options.email ?? `person${String(accountNumber)}@example.test`;
  const password = options.password === undefined ? `a long password number ${String(accountNumber)}` : options.password;
  const passwordHash = password === null ? null : await hashPassword(password);
  await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${id}, true)`;
    await tx`
      INSERT INTO accounts (id, email, display_name, password_hash, disabled_at)
      VALUES (${id}, ${email}, 'Test account', ${passwordHash}, ${options.disabled === true ? new Date() : null})`;
  });
  return { id, email, password: password ?? "" };
}

export interface SessionRow {
  id: string;
  token_hash: Buffer;
  account_id: string;
  level: string;
  remember: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  ip_prefix: string | null;
  user_agent: string | null;
}

export async function sessionRows(database: TestDatabase, accountId: string): Promise<SessionRow[]> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<SessionRow[]>`SELECT * FROM sessions WHERE account_id = ${accountId} ORDER BY created_at, id`;
  });
  return [...rows];
}

/** Ends the sliding window of every session of the account a second ago. */
export async function expireSessions(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE account_id = ${accountId}`;
  });
}

export async function disableAccount(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET disabled_at = now() WHERE id = ${accountId}`;
  });
}

/** Records a password change a moment after the account's sessions were created. */
export async function changePassword(database: TestDatabase, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE accounts SET password_changed_at = now() + interval '1 second' WHERE id = ${accountId}`;
  });
}

export function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}
