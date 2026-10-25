import { createHash } from "node:crypto";
import type { NewBookmark } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, bookmarkRepository, idempotencyRepository, instanceRepository, invitationRepository, type TenantTx } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The order in which the deletion of an account and an idempotent create of the same account lock the account row and
// the workspace row (doc 05 sections 2.10, 3.3 and 7.1). The deletion locks the workspaces and then the account; the
// claim of the key inserts into idempotency_keys, whose foreign key takes the account row FOR KEY SHARE, and the create
// then writes in the workspace. A claim that took the account first and the workspace after would wait on the deletion
// while the deletion waits on it, and the database would abort one of the two with a deadlock error. The failure
// scenario: an account has an idempotent create in flight, with its key claimed, when it deletes itself or an instance
// admin deletes it, and one of the two requests ends in a server error.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const DEADLOCK_DETECTED = "40P01";
const SECRET = Buffer.from("sealed-totp-secret");
/** Longer than the 5 s a claim waits for a key that another request holds. */
const LONGER_THAN_KEY_WAIT_MS = 6_000;

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

/** How many backends of this database wait for a lock. */
async function backendsWaitingForLock(): Promise<number> {
  const rows = await db.owner<{ waiting: string }[]>`
    SELECT count(DISTINCT l.pid)::text AS waiting
    FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid
    WHERE NOT l.granted AND s.datname = current_database()`;
  return Number(rows[0]?.waiting ?? 0);
}

async function waitUntilWaiting(backends: number, what: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_DEADLINE_MS;
  while ((await backendsWaitingForLock()) < backends) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never waited for a lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

type Settled<T> = { readonly value: T } | { readonly error: unknown };

function settle<T>(work: Promise<T>): Promise<Settled<T>> {
  return work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function errorCode(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    const direct = (error as { code?: unknown }).code;
    if (direct !== undefined) {
      return direct;
    }
    return errorCode((error as { cause?: unknown }).cause);
  }
  return undefined;
}

let counter = 0;

interface Person {
  readonly id: string;
}

async function person(options: { readonly admin?: boolean } = {}): Promise<Person> {
  counter += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `idempotency-deletion-${String(counter)}@example.test`, passwordHash: "$argon2id$stub", isInstanceAdmin: options.admin === true, emailVerified: true });
  if (options.admin === true) {
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET mfa_enabled_at = now(), mfa_secret = ${SECRET}, mfa_secret_key_id = 'key-1', mfa_last_step = 42 WHERE id = ${id}`;
    });
  }
  return { id };
}

/** A workspace the subject belongs to with `role` and another owner keeps, so deleting the subject does not delete it. */
async function sharedWorkspace(subject: Person, role: Role): Promise<string> {
  const keeper = await person();
  const workspaceId = await seedWorkspace(db, { name: "Shared" });
  await seedMember(db, { workspaceId, accountId: keeper.id, role: "owner" });
  await seedMember(db, { workspaceId, accountId: subject.id, role });
  await asSystem(db, (tx) => tx`INSERT INTO workspace_settings (workspace_id) VALUES (${workspaceId})`);
  return workspaceId;
}

function bookmarkOf(ownerId: string): NewBookmark {
  return { id: freshId(), ownerId, url: "https://example.com/docs", urlCanonical: "https://example.com/docs", host: "example.com", title: "Docs", description: null, pinned: false };
}

const hash = (text: string): Buffer => createHash("sha256").update(text).digest();

async function deleteSelf(subject: Person): Promise<boolean> {
  return db.tenant.withTenant({ accountId: subject.id, requestId: "idempotency-delete-self" }, async (tx) => {
    const repository = accountDeletionRepository(tx);
    const { blocking, soleMember, lastInstanceAdmin } = await repository.scope();
    if (lastInstanceAdmin || blocking.length > 0) {
      return false;
    }
    return repository.delete(
      soleMember.map((workspace) => workspace.id),
      [],
    );
  });
}

async function deleteAsAdmin(admin: Person, subject: Person): Promise<string> {
  return db.tenant.withTenant({ accountId: admin.id, requestId: "idempotency-delete-instance" }, async (tx) => {
    const repository = instanceRepository(tx);
    const scope = await repository.accountDeletionScope(subject.id);
    if (scope.kind !== "ok" || scope.blocking.length > 0) {
      return scope.kind === "ok" ? "last_owner" : scope.kind;
    }
    return repository.deleteAccount({ accountId: subject.id, soleWorkspaceIds: scope.soleMember.map((workspace) => workspace.id), eventId: freshId(), ipPrefix: "10.1.0.0/16" }, []);
  });
}

/**
 * Runs an idempotent create of `subject` in `workspaceId` the way stage 9a does (claim, the handler's writes, complete) and
 * holds its transaction open after the claim until `deletion` waits for a lock, then lets it go on. Resolves with the outcome
 * of both.
 */
async function interleave<D>(subject: Person, workspaceId: string, operation: string, write: (tx: TenantTx) => Promise<unknown>, deletion: () => Promise<D>): Promise<{ readonly creating: Settled<string>; readonly deleting: Settled<D> }> {
  let claimedSignal: () => void = () => undefined;
  const claimed = new Promise<void>((resolve) => {
    claimedSignal = resolve;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const key = freshId();
  const creating = settle(
    db.tenant.withTenant({ accountId: subject.id, workspaceId, requestId: "idempotency-create" }, async (tx) => {
      const repository = idempotencyRepository(tx);
      const outcome = await repository.claim({ key, operation, requestHash: hash(operation) });
      claimedSignal();
      await released;
      await write(tx);
      await repository.complete(key, { status: 201, body: { ok: true } });
      return outcome.kind;
    }),
  );
  let deleting: Promise<Settled<D>>;
  try {
    await Promise.race([claimed, creating.then(() => Promise.reject(new Error("the create ended before it claimed its key")))]);
    deleting = settle(deletion());
    await waitUntilWaiting(1, "the deletion");
  } finally {
    release();
  }
  return { creating: await creating, deleting: await deleting };
}

function expectNoDeadlock(...outcomes: readonly Settled<unknown>[]): void {
  for (const outcome of outcomes) {
    if ("error" in outcome) {
      expect(errorCode(outcome.error)).not.toBe(DEADLOCK_DETECTED);
    }
  }
}

async function accountRows(subject: Person): Promise<number> {
  return (await asSystem(db, (tx) => tx`SELECT 1 FROM accounts WHERE id = ${subject.id}`)).length;
}

describe("deleting an account against its own idempotent create", () => {
  it(
    "queues the deletion behind a bookmark create that claimed its key, aborts neither, and ends with the bookmark made and the account gone",
    async () => {
      const subject = await person();
      const workspaceId = await sharedWorkspace(subject, "member");
      const bookmark = bookmarkOf(subject.id);

      const { creating, deleting } = await interleave(
        subject,
        workspaceId,
        "createBookmark",
        async (tx) => {
          const created = await bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [] });
          expect(created.kind).toBe("created");
        },
        () => deleteSelf(subject),
      );

      expectNoDeadlock(creating, deleting);
      expect(creating).toEqual({ value: "claimed" });
      expect(deleting).toEqual({ value: true });
      expect(await accountRows(subject)).toBe(0);
      const rows = await asSystem(db, (tx) => tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE id = ${bookmark.id}`);
      expect(rows).toHaveLength(1);
      const counted = await asSystem(db, (tx) => tx<{ bookmark_count: number }[]>`SELECT bookmark_count FROM workspaces WHERE id = ${workspaceId}`);
      expect(counted).toEqual([{ bookmark_count: 1 }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "queues the deletion behind an invitation create that claimed its key, aborts neither, and ends with the invitation written and the account gone",
    async () => {
      const subject = await person();
      const workspaceId = await sharedWorkspace(subject, "admin");
      const invitationId = freshId();

      const { creating, deleting } = await interleave(
        subject,
        workspaceId,
        "createInvitation",
        async (tx) => {
          await invitationRepository(tx).writePending({
            id: invitationId,
            email: `invitee-${invitationId}@example.test`,
            role: "member",
            teamIds: [],
            tokenHash: hash(invitationId),
            keepTokenHash: false,
            mailTicket: freshId(),
            ttlSeconds: 3600,
          });
        },
        () => deleteSelf(subject),
      );

      expectNoDeadlock(creating, deleting);
      expect(creating).toEqual({ value: "claimed" });
      expect(deleting).toEqual({ value: true });
      expect(await accountRows(subject)).toBe(0);
      const rows = await asSystem(db, (tx) => tx<{ invited_by: string | null }[]>`SELECT invited_by FROM workspace_invitations WHERE id = ${invitationId}`);
      expect(rows).toEqual([{ invited_by: null }]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "queues an instance admin's deletion of the account behind a bookmark create that claimed its key, aborts neither, and ends with the bookmark made and the account gone",
    async () => {
      const admin = await person({ admin: true });
      const subject = await person();
      const workspaceId = await sharedWorkspace(subject, "member");
      const bookmark = bookmarkOf(subject.id);

      const { creating, deleting } = await interleave(
        subject,
        workspaceId,
        "createBookmark",
        async (tx) => {
          const created = await bookmarkRepository(tx).create({ bookmark, ceiling: null, jobs: [] });
          expect(created.kind).toBe("created");
        },
        () => deleteAsAdmin(admin, subject),
      );

      expectNoDeadlock(creating, deleting);
      expect(creating).toEqual({ value: "claimed" });
      expect(deleting).toEqual({ value: "deleted" });
      expect(await accountRows(subject)).toBe(0);
      const rows = await asSystem(db, (tx) => tx<{ owner_id: string | null }[]>`SELECT owner_id FROM bookmarks WHERE id = ${bookmark.id}`);
      expect(rows).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the workspace lock of a claim", () => {
  /** Holds the workspace row FOR UPDATE, as the deletion of an account does, until `release` is called. */
  async function holdWorkspace(workspaceId: string): Promise<{ readonly release: () => void; readonly done: Promise<Settled<void>> }> {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => undefined;
    const workspaceHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const done = settle(
      db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        held();
        await released;
      }),
    );
    await workspaceHeld;
    return { release, done };
  }

  it(
    "waits for the workspace lock for longer than the key wait without reporting the key as busy",
    async () => {
      const subject = await person();
      const workspaceId = await sharedWorkspace(subject, "member");
      const holding = await holdWorkspace(workspaceId);
      let claiming: Promise<Settled<string>>;
      try {
        claiming = settle(
          db.tenant.withTenant({ accountId: subject.id, workspaceId, requestId: "idempotency-workspace-wait" }, async (tx) => {
            const outcome = await idempotencyRepository(tx).claim({ key: freshId(), operation: "createBookmark", requestHash: hash("wait") });
            return outcome.kind;
          }),
        );
        await waitUntilWaiting(1, "the claim");
        await new Promise((resolve) => setTimeout(resolve, LONGER_THAN_KEY_WAIT_MS));
      } finally {
        holding.release();
      }

      expect(await claiming).toEqual({ value: "claimed" });
      expect(await holding.done).toEqual({ value: undefined });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is not taken by a claim in an account-level transaction",
    async () => {
      const subject = await person();
      const workspaceId = await sharedWorkspace(subject, "member");
      const holding = await holdWorkspace(workspaceId);
      let outcome: Settled<string>;
      try {
        outcome = await settle(
          db.tenant.withTenant({ accountId: subject.id, requestId: "idempotency-account-claim" }, async (tx) => {
            const claimed = await idempotencyRepository(tx).claim({ key: freshId(), operation: "createBookmark", requestHash: hash("account") });
            return claimed.kind;
          }),
        );
      } finally {
        holding.release();
      }

      expect(outcome).toEqual({ value: "claimed" });
      expect(await holding.done).toEqual({ value: undefined });
    },
    TEST_TIMEOUT_MS,
  );
});
