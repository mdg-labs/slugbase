import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type { TestDatabase } from "../../src/testing.ts";

// Fixtures for the account and session tests, written the way the test
// database allows: `accounts` has forced row-level security with the own-row
// policy, so the table owner inserts a row by naming the account in the
// setting; `sessions` has no policy at all, so the owner reads and changes it
// as slugbase_system (the owner is a member of that role, doc 05 section 3.1),
// which stands for the system operations here.

export interface SeedAccount {
  readonly id: string;
  readonly email: string;
  readonly passwordHash?: string | null;
  readonly disabledAt?: Date | null;
  readonly passwordChangedAt?: Date | null;
  readonly isInstanceAdmin?: boolean;
}

let counter = 0;

/** A UUID-shaped identifier that is unique within the process. */
export function freshId(): string {
  counter += 1;
  return `0192f3a0-aaaa-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

export function sha256(value: Buffer | string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function freshToken(): { token: Buffer; hash: Buffer } {
  const token = randomBytes(32);
  return { token, hash: sha256(token) };
}

export async function seedAccount(database: TestDatabase, account: SeedAccount): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${account.id}, true)`;
    await tx`
      INSERT INTO accounts (id, email, display_name, password_hash, disabled_at, password_changed_at, is_instance_admin)
      VALUES (${account.id}, ${account.email}, 'Test account', ${account.passwordHash ?? null},
              ${account.disabledAt ?? null}, ${account.passwordChangedAt ?? null}, ${account.isInstanceAdmin ?? false})`;
  });
}

/** Runs `work` in a transaction of the owner acting as slugbase_system, which reads and writes `sessions`. */
export async function asSystem<T>(database: TestDatabase, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return { value: await work(tx) };
  });
  return result.value;
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

export async function sessionRows(database: TestDatabase, accountId?: string): Promise<SessionRow[]> {
  return asSystem(database, async (tx) => {
    const rows =
      accountId === undefined
        ? await tx<SessionRow[]>`SELECT * FROM sessions ORDER BY created_at, id`
        : await tx<SessionRow[]>`SELECT * FROM sessions WHERE account_id = ${accountId} ORDER BY created_at, id`;
    return [...rows];
  });
}
