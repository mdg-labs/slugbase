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
  readonly emailVerified?: boolean;
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
      INSERT INTO accounts (id, email, display_name, password_hash, disabled_at, email_verified_at)
      VALUES (${id}, ${email}, 'Test account', ${passwordHash}, ${options.disabled === true ? new Date() : null},
              ${options.emailVerified === true ? new Date() : null})`;
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

let workspaceNumber = 0;

/** Creates a workspace as slugbase_system, which stands for the system operation that does: slugbase_app cannot insert one. */
export async function seedWorkspace(database: TestDatabase, options: { readonly name?: string; readonly deleting?: boolean } = {}): Promise<string> {
  workspaceNumber += 1;
  const id = `0192f3a0-cccc-7000-8000-${workspaceNumber.toString(16).padStart(12, "0")}`;
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspaces (id, name, deleting_at)
      VALUES (${id}, ${options.name ?? `Workspace ${String(workspaceNumber)}`}, ${options.deleting === true ? new Date() : null})`;
  });
  return id;
}

export async function seedMembership(
  database: TestDatabase,
  membership: { readonly workspaceId: string; readonly accountId: string; readonly role?: "owner" | "admin" | "member"; readonly lastActiveAt?: Date | null },
): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`
      INSERT INTO workspace_members (workspace_id, account_id, role, last_active_at)
      VALUES (${membership.workspaceId}, ${membership.accountId}, ${membership.role ?? "member"}, ${membership.lastActiveAt ?? null})`;
  });
}

export async function removeMembership(database: TestDatabase, workspaceId: string, accountId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
}

/** Sets the active workspace of a session whatever the account's memberships are, as a forged value would be. */
export async function setActiveWorkspace(database: TestDatabase, sessionId: string, workspaceId: string | null): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE sessions SET active_workspace_id = ${workspaceId} WHERE id = ${sessionId}`;
  });
}

export async function lastActiveAt(database: TestDatabase, workspaceId: string, accountId: string): Promise<Date | null> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ last_active_at: Date | null }[]>`
      SELECT last_active_at FROM workspace_members WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
  return rows[0]?.last_active_at ?? null;
}

export async function setLastActiveAt(database: TestDatabase, workspaceId: string, accountId: string, at: Date | null): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_members SET last_active_at = ${at} WHERE workspace_id = ${workspaceId} AND account_id = ${accountId}`;
  });
}

/** A digest of the workspace's rows in both workspace tables, read as slugbase_system. */
export async function workspaceChecksum(database: TestDatabase, workspaceId: string): Promise<string> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<{ digest: string }[]>`
      SELECT md5(
        coalesce((SELECT string_agg(w::text, '|' ORDER BY w.id) FROM workspaces w WHERE w.id = ${workspaceId}), '') ||
        coalesce((SELECT string_agg(m::text, '|' ORDER BY m.account_id) FROM workspace_members m WHERE m.workspace_id = ${workspaceId}), '')
      ) AS digest`;
  });
  const digest = rows[0]?.digest;
  if (digest === undefined) {
    throw new Error("the checksum query returned no row");
  }
  return digest;
}

/**
 * How many times longer `probe` takes than `reference`, as the median over
 * `rounds` of the per-round ratio. Each round times both back to back, and the
 * order alternates, so a burst of load on a shared runner lands on both sides of
 * a round and a single slow round moves one ratio of the many, not the median.
 * Both run once first, unmeasured, to warm caches and lazily made state.
 */
export async function medianLatencyRatio(
  reference: () => Promise<unknown>,
  probe: () => Promise<unknown>,
  rounds = 21,
): Promise<number> {
  const timed = async (run: () => Promise<unknown>): Promise<number> => {
    const started = performance.now();
    await run();
    return performance.now() - started;
  };
  await reference();
  await probe();
  const ratios: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    let referenceTime: number;
    let probeTime: number;
    if (round % 2 === 0) {
      referenceTime = await timed(reference);
      probeTime = await timed(probe);
    } else {
      probeTime = await timed(probe);
      referenceTime = await timed(reference);
    }
    ratios.push(probeTime / referenceTime);
  }
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)] ?? 0;
}
