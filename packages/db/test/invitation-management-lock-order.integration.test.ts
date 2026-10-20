import {
  createAuditWriter,
  createInvitationLink,
  generateCredentialToken,
  resendInvitation,
  revokeInvitation,
  type InvitationAcceptResult,
  type InvitationActionAsk,
  type InvitationManagementStore,
  type InvitationSignupResult,
} from "@slugbase/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventRepository, createAuthStore, invitationAcceptanceRepository, invitationRepository, type AuthStore } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The order in which revoking, resending and giving a link to a pending invitation lock the rows they share with its
// acceptance (doc 05 section 3.3, doc 02 section 3.4, doc 04 section 10.5). Each of the three changes the invitation
// row and then writes its audit event, whose foreign key to the workspace takes a `FOR KEY SHARE` lock on the
// workspace row; an acceptance locks the workspace row first and the invitation row second. An acceptance whose
// workspace lock the audit insert waits on would wait on the invitation row the management request holds, and the
// database would abort one of the two with a deadlock error. The failure scenario: an admin revokes (resends, gives a
// link to) a pending invitation at the moment the invitee accepts it, the accept succeeds and the admin's request ends
// in a server error.
//
// Each test holds the management request between its write to the invitation and its audit event until the
// acceptance waits for a lock, so the interleaving is the one that deadlocks and does not depend on timing.

const HOOK_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_DEADLINE_MS = 20_000;
const POLL_MS = 25;
const DEADLOCK_DETECTED = "40P01";
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA";
const TTL_SECONDS = 7 * 24 * 60 * 60;

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

function gate(): { readonly open: () => void; readonly opened: Promise<void> } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

interface Scene {
  readonly workspaceId: string;
  readonly adminId: string;
  readonly inviteeId: string | null;
  readonly email: string;
  readonly invitationId: string;
  readonly tokenHash: Buffer;
}

/** A workspace with an admin and a pending invitation of an address that an account holds, or of one nobody holds. */
async function scene(options: { readonly inviteeHasAccount: boolean }): Promise<Scene> {
  const adminId = freshId();
  const email = `invitee-${freshId()}@example.test`;
  await seedAccount(db, { id: adminId, email: `admin-${adminId}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  let inviteeId: string | null = null;
  if (options.inviteeHasAccount) {
    inviteeId = freshId();
    await seedAccount(db, { id: inviteeId, email, passwordHash: "$argon2id$stub", emailVerified: true });
  }
  const workspaceId = await seedWorkspace(db, { name: "Invitations lock order" });
  await seedMember(db, { workspaceId, accountId: adminId, role: "admin" });
  const invitationId = freshId();
  const { hash } = freshToken();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${invitationId}, ${workspaceId}, ${email}, 'member', ${hash}, ${adminId}, now() + interval '1 day')`,
  );
  return { workspaceId, adminId, inviteeId, email, invitationId, tokenHash: hash };
}

type Management = (store: InvitationManagementStore, ask: InvitationActionAsk, audit: ReturnType<typeof createAuditWriter>) => Promise<string>;

const MANAGEMENTS: readonly { readonly name: string; readonly run: Management; readonly kind: string; readonly settledStatus: "pending" | "revoked" }[] = [
  {
    name: "revoking",
    run: async (managementStore, ask, audit) => (await revokeInvitation({ store: managementStore, audit }, ask)).kind,
    kind: "revoked",
    settledStatus: "revoked",
  },
  {
    name: "resending",
    run: async (managementStore, ask, audit) =>
      (await resendInvitation({ store: managementStore, audit, newId: freshId, ttlSeconds: TTL_SECONDS }, ask)).kind,
    kind: "resent",
    settledStatus: "pending",
  },
  {
    name: "giving a link to",
    run: async (managementStore, ask, audit) =>
      (await createInvitationLink({ store: managementStore, audit, ttlSeconds: TTL_SECONDS }, ask)).kind,
    kind: "linked",
    settledStatus: "pending",
  },
];

const ACCEPTANCES = [
  { name: "a signed-in accept", inviteeHasAccount: true },
  { name: "a sign-up through the link", inviteeHasAccount: false },
] as const;

function accepting(scenario: Scene, requestId: string): Promise<Settled<InvitationAcceptResult | InvitationSignupResult>> {
  if (scenario.inviteeId !== null) {
    const accountId = scenario.inviteeId;
    return settle(
      db.tenant.withTenant({ accountId, requestId }, (tx): Promise<InvitationAcceptResult | InvitationSignupResult> => invitationAcceptanceRepository(tx).accept(scenario.tokenHash, null)),
    );
  }
  const session = freshToken();
  return settle(
    store.acceptInvitationWithNewAccount({
      tokenHash: scenario.tokenHash,
      accountId: freshId(),
      displayName: "Grace Hopper",
      passwordHash: PASSWORD_HASH,
      locale: "en",
      seatLimit: null,
      session: { id: freshId(), tokenHash: session.hash, replacedTokenHash: null, ipPrefix: "203.0.0.0/16", userAgent: "tests" },
      onAccepted: () => ({ audit: [], jobs: [] }),
    }),
  );
}

function askOf(scenario: Scene): InvitationActionAsk {
  return {
    workspaceId: scenario.workspaceId,
    actor: { type: "account", accountId: scenario.adminId, label: "Admin" },
    actorLocale: "en",
    invitationId: scenario.invitationId,
    ipPrefix: null,
  };
}

async function invitationStatus(invitationId: string): Promise<string | undefined> {
  const rows = await asSystem(db, (tx) => tx<{ status: string }[]>`SELECT status FROM workspace_invitations WHERE id = ${invitationId}`);
  return rows[0]?.status;
}

async function membershipsOf(workspaceId: string, email: string): Promise<number> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ members: string }[]>`
      SELECT count(*)::text AS members FROM workspace_members m JOIN accounts a ON a.id = m.account_id
      WHERE m.workspace_id = ${workspaceId} AND a.email = ${email}`,
  );
  return Number(rows[0]?.members ?? 0);
}

async function auditActionsOf(workspaceId: string): Promise<string[]> {
  const rows = await asSystem(db, (tx) => tx<{ action: string }[]>`SELECT action FROM audit_events WHERE workspace_id = ${workspaceId} ORDER BY id`);
  return rows.map((row) => row.action);
}

describe.each(MANAGEMENTS)("$name a pending invitation against its acceptance", (management) => {
  it.each(ACCEPTANCES)(
    "queues the acceptance behind the request, aborts neither, and ends with the acceptance refused for $name",
    async ({ inviteeHasAccount }) => {
      const scenario = await scene({ inviteeHasAccount });
      const ask = askOf(scenario);
      const written = gate();
      const acceptanceWaits = gate();

      // The management request writes the invitation and holds its row; the acceptance is started then, locks the
      // workspace row and waits for the invitation row; only then does the request go on to its audit event.
      const managing = settle(
        db.tenant.withTenant({ accountId: scenario.adminId, workspaceId: scenario.workspaceId, requestId: "management-lock-order" }, async (tx) => {
          const repository = invitationRepository(tx);
          const heldStore: InvitationManagementStore = {
            actorRole: () => repository.actorRole(),
            pending: (id) => repository.pending(id),
            listPending: (afterId, limit) => repository.listPending(afterId, limit),
            inviteeLocale: (id) => repository.inviteeLocale(id),
            async renew(id, renewal) {
              const renewed = await repository.renew(id, renewal);
              written.open();
              await acceptanceWaits.opened;
              return renewed;
            },
            async revoke(id) {
              const revoked = await repository.revoke(id);
              written.open();
              await acceptanceWaits.opened;
              return revoked;
            },
          };
          return management.run(heldStore, ask, createAuditWriter({ store: auditEventRepository(tx), newId: freshId }));
        }),
      );
      await written.opened;

      let acceptance: Promise<Settled<InvitationAcceptResult | InvitationSignupResult>>;
      try {
        acceptance = accepting(scenario, "management-lock-order-accept");
        await waitUntilWaiting(1, "the acceptance");
      } finally {
        acceptanceWaits.open();
      }

      const [managementOutcome, acceptanceOutcome] = await Promise.all([managing, acceptance]);

      if ("error" in managementOutcome) {
        expect(errorCode(managementOutcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
      if ("error" in acceptanceOutcome) {
        expect(errorCode(acceptanceOutcome.error)).not.toBe(DEADLOCK_DETECTED);
      }
      // The request went first: it wrote the invitation and its event and committed; the acceptance then found the
      // invitation revoked, or its token replaced, and joined nobody.
      expect(managementOutcome).toEqual({ value: management.kind });
      expect(acceptanceOutcome).toEqual({ value: { kind: "gone" } });
      expect(await invitationStatus(scenario.invitationId)).toBe(management.settledStatus);
      expect(await membershipsOf(scenario.workspaceId, scenario.email)).toBe(0);
      expect(await auditActionsOf(scenario.workspaceId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "queues the request behind an acceptance that went first, which leaves it nothing to change",
    async () => {
      const scenario = await scene({ inviteeHasAccount: true });
      const ask = askOf(scenario);
      const accepted = gate();
      const requestWaits = gate();
      const inviteeId = scenario.inviteeId ?? "";

      const accept = settle(
        db.tenant.withTenant({ accountId: inviteeId, requestId: "management-lock-order-first" }, async (tx) => {
          const result = await invitationAcceptanceRepository(tx).accept(scenario.tokenHash, null);
          accepted.open();
          await requestWaits.opened;
          return result;
        }),
      );
      await accepted.opened;
      let managing: Promise<Settled<string>>;
      try {
        managing = settle(
          db.tenant.withTenant({ accountId: scenario.adminId, workspaceId: scenario.workspaceId, requestId: "management-lock-order-second" }, (tx) => {
            const repository = invitationRepository(tx);
            return management.run(repository, ask, createAuditWriter({ store: auditEventRepository(tx), newId: freshId }));
          }),
        );
        await waitUntilWaiting(1, "the request");
      } finally {
        requestWaits.open();
      }

      const [acceptOutcome, managementOutcome] = await Promise.all([accept, managing]);

      expect(acceptOutcome).toEqual({ value: { kind: "accepted", workspaceId: scenario.workspaceId, invitationId: scenario.invitationId, role: "member" } });
      expect(managementOutcome).toEqual({ value: "not_found" });
      expect(await invitationStatus(scenario.invitationId)).toBe("accepted");
      expect(await membershipsOf(scenario.workspaceId, scenario.email)).toBe(1);
      expect(await auditActionsOf(scenario.workspaceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("issuing the token of the invitation mail against an acceptance", () => {
  // The job writes the invitation row and no row that references the workspace, so it shares no lock with the
  // acceptance but the invitation row itself.
  it("queues the acceptance behind the job, and the acceptance finds the token it carried replaced", async () => {
    const scenario = await scene({ inviteeHasAccount: true });
    const ticket = freshId();
    await asSystem(db, (tx) => tx`UPDATE workspace_invitations SET mail_ticket = ${ticket} WHERE id = ${scenario.invitationId}`);
    const issued = gate();
    const acceptanceWaits = gate();

    const issuing = settle(
      db.tenant.withTenant({ accountId: scenario.adminId, workspaceId: scenario.workspaceId, requestId: "management-lock-order-mail" }, async (tx) => {
        const context = await invitationRepository(tx).issueToken(scenario.invitationId, ticket, generateCredentialToken().hash);
        issued.open();
        await acceptanceWaits.opened;
        return context?.email;
      }),
    );
    await issued.opened;
    let acceptance: Promise<Settled<InvitationAcceptResult | InvitationSignupResult>>;
    try {
      acceptance = accepting(scenario, "management-lock-order-mail-accept");
      await waitUntilWaiting(1, "the acceptance");
    } finally {
      acceptanceWaits.open();
    }

    const [issueOutcome, acceptanceOutcome] = await Promise.all([issuing, acceptance]);

    expect(issueOutcome).toEqual({ value: scenario.email });
    expect(acceptanceOutcome).toEqual({ value: { kind: "gone" } });
    expect(await invitationStatus(scenario.invitationId)).toBe("pending");
  });
});
