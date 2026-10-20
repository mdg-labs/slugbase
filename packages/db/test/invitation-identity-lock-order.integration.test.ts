import type { InvitationIdentityResult } from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDeletionRepository, createAuthStore, type AuthStore } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The order in which accepting an invitation through an OIDC provider and deleting the account that holds the invited
// address lock the rows they share (doc 05 section 3.3, doc 02 sections 2.8 and 2.10). The acceptance locks the workspace
// row and then the account row of the person the provider identified; the deletion of the account locks the workspaces the
// account created or belongs to before the account row. A function that locked the account first and the workspace
// after would wait on the deletion while the deletion waits on it, and the database would abort one of the two with a
// deadlock error. The failure scenario: an account that created a workspace and left it deletes itself at the moment the
// provider signs that account in to accept an invitation to that workspace, and one of the two requests ends in a
// server error.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const DEADLOCK_DETECTED = "40P01";

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 2 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
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

function settle<T>(work: Promise<T>): Promise<{ readonly value: T } | { readonly error: unknown }> {
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

describe("accepting an invitation through a provider against the deletion of the account that holds the invited address", () => {
  it(
    "queues the deletion behind the acceptance, aborts neither, and ends with the acceptance made and the account gone",
    async () => {
      const subjectId = freshId();
      const ownerId = freshId();
      const email = `identity-lock-order-${subjectId}@example.test`;
      await seedAccount(db, { id: subjectId, email, passwordHash: "$argon2id$stub", emailVerified: true });
      await seedAccount(db, { id: ownerId, email: `identity-lock-order-owner-${ownerId}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
      // The subject created the workspace and left it; another owner remains, and an admin invited the subject's address.
      const workspaceId = await seedWorkspace(db, { name: "Created and left", createdBy: subjectId });
      await seedMember(db, { workspaceId, accountId: ownerId, role: "owner" });
      const invitationId = freshId();
      const { hash } = freshToken();
      await asSystem(
        db,
        (tx) => tx`
          INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
          VALUES (${invitationId}, ${workspaceId}, ${email}, 'member', ${hash}, ${ownerId}, now() + interval '1 day')`,
      );

      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held: () => void = () => undefined;
      const workspaceHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      // The workspace row is held, as an acceptance holds it between its first and its second lock, so that the order in
      // which the two requests queue behind it is the order in which they go on once it is released.
      const holding = db.owner.begin(async (tx) => {
        await tx`SET LOCAL ROLE slugbase_system`;
        await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        held();
        await released;
      });
      const holdingSettled = settle(holding);
      await workspaceHeld;

      const session = freshToken();
      const accepting = settle<InvitationIdentityResult>(
        store.acceptInvitationWithIdentity({
          tokenHash: hash,
          provider: "idp",
          subject: "lock-order-subject",
          email,
          identityId: freshId(),
          accountId: freshId(),
          displayName: "Grace Hopper",
          locale: "en",
          mayCreate: false,
          seatLimit: null,
          session: { id: freshId(), tokenHash: session.hash, replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
          onAccepted: () => ({ audit: [], jobs: [] }),
        }),
      );
      let deleting: Promise<{ readonly value: boolean } | { readonly error: unknown }>;
      try {
        await waitUntilWaiting(1, "the acceptance");
        deleting = settle(
          db.tenant.withTenant({ accountId: subjectId, requestId: "identity-lock-order-delete" }, async (tx) => {
            const repository = accountDeletionRepository(tx);
            const { blocking, soleMember, lastInstanceAdmin } = await repository.scope();
            if (lastInstanceAdmin || blocking.length > 0) {
              return false;
            }
            return repository.delete(
              soleMember.map((workspace) => workspace.id),
              [],
            );
          }),
        );
        await waitUntilWaiting(2, "the deletion");
      } finally {
        release();
      }

      const [holdOutcome, acceptOutcome, deleteOutcome] = await Promise.all([holdingSettled, accepting, deleting]);

      expect(holdOutcome).toEqual({ value: undefined });
      if ("error" in acceptOutcome) {
        expect(errorCode(acceptOutcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
      if ("error" in deleteOutcome) {
        expect(errorCode(deleteOutcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
      // The acceptance went first: the account joined, and was deleted afterwards.
      expect(acceptOutcome).toEqual({ value: { kind: "accepted", workspaceId, invitationId, role: "member", accountId: subjectId, created: false } });
      expect(deleteOutcome).toEqual({ value: true });

      const left = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${subjectId}`);
      expect(left).toHaveLength(0);
      const invitation = await asSystem(db, (tx) => tx<{ status: string }[]>`SELECT status FROM workspace_invitations WHERE id = ${invitationId}`);
      expect(invitation).toEqual([{ status: "accepted" }]);
    },
    TEST_TIMEOUT_MS,
  );
});
