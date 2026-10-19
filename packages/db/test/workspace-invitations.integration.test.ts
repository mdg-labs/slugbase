import type { InvitationRole } from "@slugbase/core";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invitationRepository } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace, type Role } from "./support/workspace-fixture.ts";

// The invitations of a workspace (doc 05 sections 2.2 and 3.3, doc 02 section 3.4, doc 10 T1 and T19). The
// failure scenarios: an invitation that grants the owner role, through the table or through the application
// role; one written with the columns that make it an owner's or an accepted one; a workspace B's invitation
// read, written or replaced from a transaction acting in A; two requests for one address that leave two pending
// invitations; a resend that leaves the earlier link working; a token that can be read back; and a language
// asked of an address nobody invited, by a caller who may not invite; and, for the management of a pending
// invitation, a resend or link that leaves the earlier token working, a revocation that reopens, accepts or
// changes another workspace's invitation, and a purge that deletes a pending one. The RLS-only checks run statements as
// slugbase_app with the tenant settings of A and no application layer.

const HOOK_TIMEOUT_MS = 300_000;
const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const TTL_SECONDS = 7 * 24 * 60 * 60;
const TICKET = "0192f3a0-ffff-7000-8000-000000000001";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(options: { email?: string; locale?: "en" | "de" } = {}): Promise<{ id: string; email: string }> {
  emailNumber += 1;
  const id = freshId();
  const email = options.email ?? `invite${String(emailNumber)}@example.test`;
  await seedAccount(db, { id, email, passwordHash: "$argon2id$stub" });
  if (options.locale !== undefined) {
    const locale = options.locale;
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${id}, true)`;
      await tx`UPDATE accounts SET locale = ${locale} WHERE id = ${id}`;
    });
  }
  return { id, email };
}

interface Workspace {
  readonly workspaceId: string;
  readonly members: readonly { readonly accountId: string; readonly role: Role; readonly email: string }[];
}

/** A workspace with one member of each role given, in that order. */
async function workspaceOf(...roles: Role[]): Promise<Workspace> {
  const workspaceId = await seedWorkspace(db, { name: "Invitations test" });
  const members: { accountId: string; role: Role; email: string }[] = [];
  for (const role of roles) {
    const { id, email } = await account();
    await seedMember(db, { workspaceId, accountId: id, role });
    members.push({ accountId: id, role, email });
  }
  return { workspaceId, members };
}

function who(workspace: Workspace, index: number): string {
  const member = workspace.members[index];
  if (member === undefined) {
    throw new Error("no such member");
  }
  return member.accountId;
}

function inTenant<T>(tenant: { accountId: string; workspaceId?: string }, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ ...tenant, requestId: "invitations-test" }, work);
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(settings: { accountId: string; workspaceId?: string }, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${settings.accountId}, true), set_config('app.workspace_id', ${settings.workspaceId ?? ""}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

async function refusedWith(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
      const { code, cause } = current as { code?: unknown; cause?: unknown };
      if (typeof code === "string") {
        return code;
      }
      current = cause;
    }
    throw error;
  }
  return undefined;
}

interface Row {
  id: string;
  accepted_by: string | null;
  workspace_id: string;
  email: string;
  role: string;
  instance_issued: boolean;
  team_ids: string[];
  token_hash: Buffer;
  invited_by: string | null;
  status: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

function rowsOf(workspaceId: string): Promise<Row[]> {
  return asSystem(db, async (tx) => [...(await tx<Row[]>`SELECT * FROM workspace_invitations WHERE workspace_id = ${workspaceId} ORDER BY created_at, id`)]);
}

async function checksum(workspaceId: string): Promise<string> {
  const rows = await asSystem(
    db,
    (tx) => tx<{ digest: string }[]>`
      SELECT md5(coalesce((SELECT string_agg(i::text, '|' ORDER BY i.id) FROM workspace_invitations i WHERE i.workspace_id = ${workspaceId}), '')) AS digest`,
  );
  return rows[0]?.digest ?? "";
}

function newInvitation(email: string, overrides: { role?: InvitationRole; ttlSeconds?: number; keepTokenHash?: boolean } = {}) {
  return {
    id: freshId(),
    email,
    role: overrides.role ?? "member",
    teamIds: [],
    tokenHash: freshToken().hash,
    keepTokenHash: overrides.keepTokenHash ?? false,
    mailTicket: freshId(),
    ttlSeconds: overrides.ttlSeconds ?? TTL_SECONDS,
  };
}

/** A pending invitation of `workspaceId` for `email`, written as the system role the way a seed does. */
async function seedInvitation(workspaceId: string, email: string, overrides: { status?: string; expiresInSeconds?: number; mailTicket?: string } = {}): Promise<string> {
  const id = freshId();
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, mail_ticket, status, closed_at, expires_at)
      VALUES (${id}, ${workspaceId}, ${email}, 'member', ${freshToken().hash}, ${overrides.mailTicket ?? null}, ${overrides.status ?? "pending"},
              ${(overrides.status ?? "pending") === "pending" ? null : new Date()}, now() + ${overrides.expiresInSeconds ?? TTL_SECONDS} * interval '1 second')`,
  );
  return id;
}

describe("the table, its privileges and its policies", () => {
  it("has row-level security enabled and forced and a policy for each command the application role may use", async () => {
    const [table] = await db.owner<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.workspace_invitations'::regclass`;
    const policies = await db.owner<{ name: string; command: string }[]>`
      SELECT polname AS name, polcmd AS command FROM pg_policy WHERE polrelid = 'public.workspace_invitations'::regclass ORDER BY polname`;

    expect(table).toEqual({ enabled: true, forced: true });
    expect(policies).toEqual([
      { name: "workspace_invitations_tenant", command: "r" },
      { name: "workspace_invitations_tenant_insert", command: "a" },
      { name: "workspace_invitations_tenant_update", command: "w" },
    ]);
  });

  it("lets the application role insert the columns of a pending invitation and none that make it an owner's or an accepted one, update what a resend replaces and the status, and never delete", async () => {
    const columns = async (privilege: string): Promise<string[]> => {
      const rows = await db.owner<{ column: string }[]>`
        SELECT a.attname AS column FROM pg_attribute a
        WHERE a.attrelid = 'public.workspace_invitations'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('slugbase_app', 'public.workspace_invitations', a.attname, ${privilege})
        ORDER BY a.attname`;
      return rows.map((row) => row.column);
    };

    expect(await columns("INSERT")).toEqual(["email", "expires_at", "id", "invited_by", "mail_ticket", "role", "team_ids", "token_hash", "workspace_id"]);
    expect(await columns("UPDATE")).toEqual(["closed_at", "expires_at", "invited_by", "mail_ticket", "role", "status", "team_ids", "token_hash"]);
    const [table] = await db.owner<{ canDelete: boolean }[]>`SELECT has_table_privilege('slugbase_app', 'public.workspace_invitations', 'DELETE') AS "canDelete"`;
    expect(table?.canDelete).toBe(false);
  });

  it("refuses an owner invitation unless it is instance-issued, and the application role can write neither the flag nor the status", async () => {
    const { workspaceId, members } = await workspaceOf("owner");
    const actor = { accountId: members[0]?.accountId ?? "", workspaceId };

    const direct = await refusedWith(asSystem(db, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o1@example.test', 'owner', ${freshToken().hash}, now() + interval '1 day')`));
    const issued = await refusedWith(asSystem(db, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o2@example.test', 'owner', true, ${freshToken().hash}, now() + interval '1 day')`));
    const asApp = await refusedWith(appAs(actor, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o3@example.test', 'owner', ${freshToken().hash}, now() + interval '1 day')`));
    const flagged = await refusedWith(appAs(actor, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, instance_issued, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o4@example.test', 'owner', true, ${freshToken().hash}, now() + interval '1 day')`));
    const accepted = await refusedWith(appAs(actor, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, status, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'o5@example.test', 'member', 'accepted', ${freshToken().hash}, now() + interval '1 day')`));

    expect(direct).toBe(CHECK_VIOLATION);
    expect(issued).toBeUndefined();
    expect(asApp).toBe(CHECK_VIOLATION);
    expect(flagged).toBe(INSUFFICIENT_PRIVILEGE);
    expect(accepted).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await rowsOf(workspaceId)).map((row) => row.email)).toEqual(["o2@example.test"]);
  });

  it("refuses a token hash that is not 32 bytes and a status outside the three", async () => {
    const workspaceId = await seedWorkspace(db, { name: "Checks" });

    const short = await refusedWith(asSystem(db, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES (${freshId()}, ${workspaceId}, 'c1@example.test', 'member', ${Buffer.from("short")}, now() + interval '1 day')`));
    const status = await refusedWith(asSystem(db, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, status, expires_at) VALUES (${freshId()}, ${workspaceId}, 'c2@example.test', 'member', ${freshToken().hash}, 'done', now() + interval '1 day')`));

    expect(short).toBe(CHECK_VIOLATION);
    expect(status).toBe(CHECK_VIOLATION);
  });

  it("keeps one pending invitation for an address in a workspace, compared without regard to case, and lets another workspace or a revoked one hold the address", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    await seedInvitation(a.workspaceId, "Same@Example.test");

    const twice = await refusedWith(seedInvitation(a.workspaceId, "same@example.test"));
    await seedInvitation(b.workspaceId, "same@example.test");
    await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    await seedInvitation(a.workspaceId, "revoked@example.test");

    expect(twice).toBe("23505");
  });

  it("shows the invitations of the workspace the transaction acts in and writes, replaces or deletes none of another, whatever the statement names", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner");
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    await seedInvitation(a.workspaceId, "own@example.test");
    const before = await checksum(b.workspaceId);
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    const listed = await appAs(actor, (tx) => tx<{ email: string }[]>`SELECT email::text AS email FROM workspace_invitations`);
    const byId = await appAs(actor, (tx) => tx`SELECT id FROM workspace_invitations WHERE id = ${foreign}`);
    const inserted = await refusedWith(appAs(actor, (tx) => tx`INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at) VALUES (${freshId()}, ${b.workspaceId}, 'planted@example.test', 'member', ${freshToken().hash}, now() + interval '1 day')`));
    const replaced = await appAs(actor, (tx) => tx`UPDATE workspace_invitations SET token_hash = ${freshToken().hash}, role = 'admin' WHERE id = ${foreign}`);
    const moved = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET workspace_id = ${b.workspaceId} WHERE workspace_id = ${a.workspaceId}`));
    const deleted = await refusedWith(appAs(actor, (tx) => tx`DELETE FROM workspace_invitations WHERE id = ${foreign}`));
    const upserted = await refusedWith(
      appAs(actor, (tx) => tx`
        INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, expires_at)
        VALUES (${freshId()}, ${b.workspaceId}, 'foreign@example.test', 'admin', ${freshToken().hash}, now() + interval '1 day')
        ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO UPDATE SET role = EXCLUDED.role`),
    );

    expect(listed.map((row) => row.email)).toEqual(["own@example.test"]);
    expect(byId).toHaveLength(0);
    expect(inserted).toBe(INSUFFICIENT_PRIVILEGE);
    expect(replaced.count).toBe(0);
    expect(moved).toBe(INSUFFICIENT_PRIVILEGE);
    expect(deleted).toBe(INSUFFICIENT_PRIVILEGE);
    expect(upserted).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await checksum(b.workspaceId)).toBe(before);
  });

  it("shows nothing to a transaction that acts in no workspace", async () => {
    const a = await workspaceOf("owner");
    await seedInvitation(a.workspaceId, "hidden@example.test");

    const listed = await appAs({ accountId: who(a, 0) }, (tx) => tx`SELECT id FROM workspace_invitations`);

    expect(listed).toHaveLength(0);
  });
});

describe("the status of an invitation under the application role", () => {
  it("lets a pending invitation of the workspace become revoked and nothing else: not accepted, not pending again once revoked, not another workspace's", async () => {
    const a = await workspaceOf("owner", "admin");
    const b = await workspaceOf("owner");
    const own = await seedInvitation(a.workspaceId, "own@example.test");
    const accepting = await seedInvitation(a.workspaceId, "accepting@example.test");
    const revoked = await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    const before = await checksum(b.workspaceId);
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    const accept = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'accepted' WHERE id = ${accepting}`));
    const invalid = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'done' WHERE id = ${accepting}`));
    const reopened = await appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'pending' WHERE id = ${revoked}`);
    const unaccepted = await appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked' WHERE id = ${accepted}`);
    const reached = await appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked' WHERE id = ${foreign}`);
    const done = await appAs(actor, (tx) => tx`UPDATE workspace_invitations SET status = 'revoked', closed_at = now() WHERE id = ${own}`);

    expect(accept).toBe(INSUFFICIENT_PRIVILEGE);
    expect(invalid).toBe(INSUFFICIENT_PRIVILEGE);
    expect(reopened.count).toBe(0);
    expect(unaccepted.count).toBe(0);
    expect(reached.count).toBe(0);
    expect(done.count).toBe(1);
    expect((await rowsOf(a.workspaceId)).map((row) => [row.id, row.status]).sort()).toEqual(
      [
        [own, "revoked"],
        [accepting, "pending"],
        [revoked, "revoked"],
        [accepted, "accepted"],
      ].sort(),
    );
    expect(await checksum(b.workspaceId)).toBe(before);
  });

  it("refuses to change the workspace, the accepting account or the owner flag of an invitation, and never lets a pending one be moved to another workspace", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const own = await seedInvitation(a.workspaceId, "own@example.test");
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    const moved = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET workspace_id = ${b.workspaceId} WHERE id = ${own}`));
    const flagged = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET instance_issued = true WHERE id = ${own}`));
    const accepter = await refusedWith(appAs(actor, (tx) => tx`UPDATE workspace_invitations SET accepted_by = ${who(a, 0)} WHERE id = ${own}`));

    expect([moved, flagged, accepter]).toEqual([INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE, INSUFFICIENT_PRIVILEGE]);
    expect((await rowsOf(a.workspaceId)).map((row) => [row.workspace_id, row.instance_issued, row.accepted_by])).toEqual([[a.workspaceId, false, null]]);
  });
});

describe("invitationRepository.writePending", () => {
  it("writes a pending invitation for the workspace of the transaction, stamped with the inviting account, that expires after the lifetime by the database's clock", async () => {
    const a = await workspaceOf("owner", "admin");
    const hash = freshToken().hash;
    const invitation = { ...newInvitation("Grace@Example.test", { role: "admin" }), tokenHash: hash };

    const written = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(invitation));

    expect(written.resent).toBe(false);
    expect(written.invitation).toMatchObject({ id: invitation.id, email: "Grace@Example.test", role: "admin", teamIds: [], status: "pending", invitedBy: who(a, 1) });
    const [row] = await rowsOf(a.workspaceId);
    expect(row).toMatchObject({ id: invitation.id, workspace_id: a.workspaceId, role: "admin", instance_issued: false, status: "pending", invited_by: who(a, 1) });
    expect(row?.token_hash.equals(hash)).toBe(true);
    expect(((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)) / 1000).toBeCloseTo(TTL_SECONDS, -1);
    expect(written.invitation.expiresAt.getTime()).toBe(row?.expires_at.getTime());
  });

  it("replaces the invitation of an address that already has a pending one, matched without regard to case: the same row with the new role, inviter, token hash and expiry", async () => {
    const a = await workspaceOf("owner", "admin");
    const first = newInvitation("grace@example.test", { role: "member", ttlSeconds: 60 });
    const second = { ...newInvitation("GRACE@example.test", { role: "admin" }) };
    await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(first));
    const [before] = await rowsOf(a.workspaceId);

    const written = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(second));

    expect(written.resent).toBe(true);
    expect(written.invitation.id).toBe(first.id);
    const rows = await rowsOf(a.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, email: "grace@example.test", role: "admin", invited_by: who(a, 1), status: "pending" });
    expect(rows[0]?.token_hash.equals(second.tokenHash)).toBe(true);
    expect(rows[0]?.token_hash.equals(first.tokenHash)).toBe(false);
    expect(before?.token_hash.equals(first.tokenHash)).toBe(true);
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(before?.expires_at.getTime() ?? 0);
    expect(rows[0]?.created_at.getTime()).toBe(before?.created_at.getTime());
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(before?.updated_at.getTime() ?? 0);
  });

  it("keeps the token hash of a pending invitation when asked to, and replaces the role, inviter, mail ticket and expiry as it does otherwise", async () => {
    const a = await workspaceOf("owner", "admin");
    const first = newInvitation("keep@example.test", { role: "member", ttlSeconds: 60 });
    const second = newInvitation("KEEP@example.test", { role: "admin", keepTokenHash: true });
    await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(first));
    const [before] = await rowsOf(a.workspaceId);

    const written = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(second));

    expect(written.resent).toBe(true);
    const rows = await rowsOf(a.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, role: "admin", invited_by: who(a, 1), status: "pending" });
    expect(rows[0]?.token_hash.equals(first.tokenHash)).toBe(true);
    expect(rows[0]?.token_hash.equals(second.tokenHash)).toBe(false);
    expect(rows[0]?.expires_at.getTime()).toBeGreaterThan(before?.expires_at.getTime() ?? 0);
    const [ticket] = await asSystem(db, (tx) => tx<{ mail_ticket: string }[]>`SELECT mail_ticket FROM workspace_invitations WHERE id = ${first.id}`);
    expect(ticket?.mail_ticket).toBe(second.mailTicket);
  });

  it("stores the hash it is given for an address without a pending invitation whatever it is asked about the token hash", async () => {
    const a = await workspaceOf("owner");
    const invitation = newInvitation("fresh@example.test", { keepTokenHash: true });

    const written = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(invitation));

    expect(written.resent).toBe(false);
    expect((await rowsOf(a.workspaceId))[0]?.token_hash.equals(invitation.tokenHash)).toBe(true);
  });

  it("writes a new invitation for an address whose earlier one was revoked, and leaves the revoked row as it was", async () => {
    const a = await workspaceOf("owner");
    const revoked = await seedInvitation(a.workspaceId, "again@example.test", { status: "revoked" });

    const written = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(newInvitation("again@example.test")));

    expect(written.resent).toBe(false);
    const rows = await rowsOf(a.workspaceId);
    expect(rows.map((row) => [row.id === revoked, row.status])).toEqual([
      [true, "revoked"],
      [false, "pending"],
    ]);
  });

  it("leaves one pending invitation when requests for one address arrive at the same moment, and exactly one of them wrote it", async () => {
    const a = await workspaceOf("owner", "admin");
    const attempts = Array.from({ length: 6 }, () => inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(newInvitation("race@example.test"))));

    const results = await Promise.all(attempts);

    expect(await rowsOf(a.workspaceId)).toHaveLength(1);
    expect(results.filter((result) => !result.resent)).toHaveLength(1);
    expect(new Set(results.map((result) => result.invitation.id)).size).toBe(1);
  });

  it("writes in the workspace of the transaction only and needs one", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");

    await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(newInvitation("scoped@example.test")));

    expect(await rowsOf(a.workspaceId)).toHaveLength(1);
    expect(await rowsOf(b.workspaceId)).toHaveLength(0);
    await expect(inTenant({ accountId: who(a, 0) }, (tx) => invitationRepository(tx).writePending(newInvitation("none@example.test")))).rejects.toMatchObject({ code: "workspace_required" });
  });

  it("refuses the owner role at the table even when the service is skipped", async () => {
    const a = await workspaceOf("owner");

    const refused = await refusedWith(
      inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) =>
        invitationRepository(tx).writePending({ ...newInvitation("owner@example.test"), role: "owner" as InvitationRole }),
      ),
    );

    expect(refused).toBe(CHECK_VIOLATION);
    expect(await rowsOf(a.workspaceId)).toHaveLength(0);
  });

  it("rolls the invitation back with the transaction", async () => {
    const a = await workspaceOf("owner");

    await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      await invitationRepository(tx).writePending(newInvitation("rollback@example.test"));
      throw new Error("the audit write failed");
    }).catch(() => undefined);

    expect(await rowsOf(a.workspaceId)).toHaveLength(0);
  });
});

describe("invitationRepository.pending and listPending", () => {
  it("reads a pending invitation of the workspace and none that is revoked, accepted or another workspace's", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const pending = await seedInvitation(a.workspaceId, "pending@example.test");
    const revoked = await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");

    const read = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      const repository = invitationRepository(tx);
      return { pending: await repository.pending(pending), revoked: await repository.pending(revoked), accepted: await repository.pending(accepted), foreign: await repository.pending(foreign) };
    });

    expect(read.pending).toMatchObject({ id: pending, email: "pending@example.test", status: "pending", role: "member" });
    expect([read.revoked, read.accepted, read.foreign]).toEqual([undefined, undefined, undefined]);
  });

  it("lists the pending invitations of the workspace newest first with whether each has expired, keyset by identifier, and never another workspace's", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const first = await seedInvitation(a.workspaceId, "first@example.test");
    const expired = await seedInvitation(a.workspaceId, "expired@example.test", { expiresInSeconds: -60 });
    await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const last = await seedInvitation(a.workspaceId, "last@example.test");
    await seedInvitation(b.workspaceId, "foreign@example.test");
    const actor = { accountId: who(a, 0), workspaceId: a.workspaceId };

    const all = await inTenant(actor, (tx) => invitationRepository(tx).listPending(null, 10));
    const firstPage = await inTenant(actor, (tx) => invitationRepository(tx).listPending(null, 2));
    const secondPage = await inTenant(actor, (tx) => invitationRepository(tx).listPending(firstPage[1]?.id ?? null, 2));

    const newestFirst = [first, expired, last].sort().reverse();
    expect(all.map((invitation) => invitation.id)).toEqual(newestFirst);
    expect(all.map((invitation) => [invitation.email, invitation.expired]).sort()).toEqual([
      ["expired@example.test", true],
      ["first@example.test", false],
      ["last@example.test", false],
    ]);
    expect([...firstPage, ...secondPage].map((invitation) => invitation.id)).toEqual(newestFirst);
    expect(secondPage).toHaveLength(1);
    expect(JSON.stringify(all)).not.toMatch(/token/i);
  });

  it("lists nothing and reads nothing for another workspace's transaction, and needs a workspace", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");

    const listed = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).listPending(null, 10));
    const read = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).pending(foreign));

    expect(listed).toEqual([]);
    expect(read).toBeUndefined();
    await expect(inTenant({ accountId: who(a, 0) }, (tx) => invitationRepository(tx).listPending(null, 10))).rejects.toMatchObject({ code: "workspace_required" });
  });
});

describe("invitationRepository.renew", () => {
  it("replaces the token hash and the expiry of a pending invitation and makes the account of the transaction its inviter, which ends the earlier link", async () => {
    const a = await workspaceOf("owner", "admin");
    const written = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(newInvitation("renew@example.test", { ttlSeconds: 60 })));
    const [before] = await rowsOf(a.workspaceId);
    const replacement = freshToken().hash;

    const renewed = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).renew(written.invitation.id, { tokenHash: replacement, mailTicket: freshId(), ttlSeconds: TTL_SECONDS }));

    const [after] = await rowsOf(a.workspaceId);
    expect(renewed).toMatchObject({ id: written.invitation.id, email: "renew@example.test", status: "pending", invitedBy: who(a, 1) });
    expect(after?.token_hash.equals(replacement)).toBe(true);
    expect(after?.token_hash.equals(before?.token_hash ?? Buffer.alloc(0))).toBe(false);
    expect(after?.invited_by).toBe(who(a, 1));
    expect(((after?.expires_at.getTime() ?? 0) - Date.now()) / 1000).toBeGreaterThan(TTL_SECONDS - 60);
    expect(renewed?.expiresAt.getTime()).toBe(after?.expires_at.getTime());
  });

  it("renews an invitation whose expiry has passed, which makes it acceptable again", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "late@example.test", { expiresInSeconds: -3600 });

    const renewed = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).renew(id, { tokenHash: freshToken().hash, mailTicket: freshId(), ttlSeconds: TTL_SECONDS }));

    expect(renewed?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it.each([
    ["revoked", { status: "revoked" }],
    ["accepted", { status: "accepted" }],
  ])("changes nothing of an invitation that is %s", async (_name, overrides) => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "gone@example.test", overrides);
    const before = await checksum(a.workspaceId);

    const renewed = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).renew(id, { tokenHash: freshToken().hash, mailTicket: freshId(), ttlSeconds: TTL_SECONDS }));

    expect(renewed).toBeUndefined();
    expect(await checksum(a.workspaceId)).toBe(before);
  });

  it("changes nothing of an invitation of another workspace", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test");
    const before = await checksum(b.workspaceId);

    const renewed = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).renew(foreign, { tokenHash: freshToken().hash, mailTicket: freshId(), ttlSeconds: TTL_SECONDS }));

    expect(renewed).toBeUndefined();
    expect(await checksum(b.workspaceId)).toBe(before);
  });

  it("leaves one token standing when two renewals arrive together: the hash of one of them", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "race@example.test");
    const hashes = [freshToken().hash, freshToken().hash];

    await Promise.all(hashes.map((tokenHash) => inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).renew(id, { tokenHash, mailTicket: freshId(), ttlSeconds: TTL_SECONDS }))));

    const [row] = await rowsOf(a.workspaceId);
    expect(hashes.filter((hash) => hash.equals(row?.token_hash ?? Buffer.alloc(0)))).toHaveLength(1);
  });
});

describe("invitationRepository.revoke", () => {
  it("revokes a pending invitation, keeps its row and answers its record", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "revoke@example.test");

    const outcome = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).revoke(id));

    expect(outcome).toMatchObject({ kind: "revoked", invitation: { id, email: "revoke@example.test", status: "revoked" } });
    expect((await rowsOf(a.workspaceId)).map((row) => [row.id, row.status])).toEqual([[id, "revoked"]]);
  });

  it("answers an invitation that is revoked already as such and writes nothing, and one that is accepted, gone or unknown as not found", async () => {
    const a = await workspaceOf("owner");
    const revoked = await seedInvitation(a.workspaceId, "revoked@example.test", { status: "revoked" });
    const accepted = await seedInvitation(a.workspaceId, "accepted@example.test", { status: "accepted" });
    const before = await checksum(a.workspaceId);

    const outcomes = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      const repository = invitationRepository(tx);
      return [await repository.revoke(revoked), await repository.revoke(accepted), await repository.revoke(freshId())];
    });

    expect(outcomes).toEqual([{ kind: "already_revoked" }, { kind: "not_found" }, { kind: "not_found" }]);
    expect(await checksum(a.workspaceId)).toBe(before);
  });

  it("revokes nothing of another workspace and answers it as not found, whether it is pending or revoked", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const pending = await seedInvitation(b.workspaceId, "pending@example.test");
    const revoked = await seedInvitation(b.workspaceId, "revoked@example.test", { status: "revoked" });
    const before = await checksum(b.workspaceId);

    const outcomes = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      const repository = invitationRepository(tx);
      return [await repository.revoke(pending), await repository.revoke(revoked)];
    });

    expect(outcomes).toEqual([{ kind: "not_found" }, { kind: "not_found" }]);
    expect(await checksum(b.workspaceId)).toBe(before);
  });

  it("rolls the revocation back with the transaction", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "rollback@example.test");

    await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, async (tx) => {
      await invitationRepository(tx).revoke(id);
      throw new Error("the audit write failed");
    }).catch(() => undefined);

    expect((await rowsOf(a.workspaceId))[0]?.status).toBe("pending");
  });

  it("revokes once when two revocations arrive together, and the other finds it revoked", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "twice@example.test");

    const outcomes = await Promise.all([1, 2].map(() => inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).revoke(id))));

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["already_revoked", "revoked"]);
  });
});

describe("invitationRepository.actorRole and memberHoldsEmail", () => {
  it("reads the role of the account in the workspace, and none for an account that is not a member", async () => {
    const a = await workspaceOf("owner", "admin", "member");
    const outsider = await account();

    const roles = await Promise.all([0, 1, 2].map((index) => inTenant({ accountId: who(a, index), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).actorRole())));
    const none = await inTenant({ accountId: outsider.id, workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).actorRole());

    expect(roles).toEqual(["owner", "admin", "member"]);
    expect(none).toBeUndefined();
  });

  it("finds a member by address without regard to case, and not an address that is a member of another workspace or of none", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner");
    const stranger = await account();
    const ask = (email: string): Promise<boolean> => inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).memberHoldsEmail(email));

    expect(await ask(a.members[1]?.email ?? "")).toBe(true);
    expect(await ask((a.members[1]?.email ?? "").toUpperCase())).toBe(true);
    expect(await ask(b.members[0]?.email ?? "")).toBe(false);
    expect(await ask(stranger.email)).toBe(false);
    expect(await ask("nobody@example.test")).toBe(false);
  });
});

describe("invitationRepository.issueToken", () => {
  it("replaces the token hash of a pending invitation, which ends the earlier link, and says what the email states", async () => {
    const a = await workspaceOf("owner");
    const invitation = newInvitation("send@example.test", { role: "admin" });
    const written = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(invitation));
    const [before] = await rowsOf(a.workspaceId);
    const issued = freshToken().hash;

    const context = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).issueToken(written.invitation.id, invitation.mailTicket, issued));

    expect(context).toEqual({ email: "send@example.test", role: "admin", expiresAt: written.invitation.expiresAt, workspaceName: "Invitations test" });
    const [after] = await rowsOf(a.workspaceId);
    expect(after?.token_hash.equals(issued)).toBe(true);
    expect(after?.token_hash.equals(before?.token_hash ?? Buffer.alloc(0))).toBe(false);
  });

  it.each([
    ["revoked", { status: "revoked" }],
    ["accepted", { status: "accepted" }],
    ["expired", { expiresInSeconds: -60 }],
  ])("changes nothing of an invitation that is %s", async (_name, overrides) => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "gone@example.test", { ...overrides, mailTicket: TICKET });
    const [before] = await rowsOf(a.workspaceId);

    const context = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).issueToken(id, TICKET, freshToken().hash));

    expect(context).toBeUndefined();
    expect((await rowsOf(a.workspaceId))[0]?.token_hash.equals(before?.token_hash ?? Buffer.alloc(0))).toBe(true);
  });

  it("changes nothing of an invitation of another workspace", async () => {
    const a = await workspaceOf("owner");
    const b = await workspaceOf("owner");
    const foreign = await seedInvitation(b.workspaceId, "foreign@example.test", { mailTicket: TICKET });
    const before = await checksum(b.workspaceId);

    const context = await inTenant({ accountId: who(a, 0), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).issueToken(foreign, TICKET, freshToken().hash));

    expect(context).toBeUndefined();
    expect(await checksum(b.workspaceId)).toBe(before);
  });
});

describe("invitationRepository.issueToken and a renewal that follows the ticket", () => {
  const as = (a: Workspace, index = 0) => ({ accountId: who(a, index), workspaceId: a.workspaceId });

  it("issues a token again for the ticket it already issued one for, which a retry of the same job needs", async () => {
    const a = await workspaceOf("owner");
    const invitation = newInvitation("retry@example.test");
    const written = await inTenant(as(a), (tx) => invitationRepository(tx).writePending(invitation));
    const first = freshToken().hash;
    const second = freshToken().hash;

    const one = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, invitation.mailTicket, first));
    const two = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, invitation.mailTicket, second));

    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect((await rowsOf(a.workspaceId))[0]?.token_hash.equals(second)).toBe(true);
  });

  it("issues nothing for a ticket that a renewal replaced: the link it stored stays", async () => {
    const a = await workspaceOf("owner");
    const invitation = newInvitation("linked@example.test");
    const written = await inTenant(as(a), (tx) => invitationRepository(tx).writePending(invitation));
    const link = freshToken().hash;
    await inTenant(as(a), (tx) => invitationRepository(tx).renew(written.invitation.id, { tokenHash: link, mailTicket: null, ttlSeconds: TTL_SECONDS }));

    const context = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, invitation.mailTicket, freshToken().hash));

    expect(context).toBeUndefined();
    expect((await rowsOf(a.workspaceId))[0]?.token_hash.equals(link)).toBe(true);
  });

  it("issues nothing for the ticket of an earlier resend, and issues for the latest one", async () => {
    const a = await workspaceOf("owner");
    const invitation = newInvitation("twice@example.test");
    const written = await inTenant(as(a), (tx) => invitationRepository(tx).writePending(invitation));
    const later = freshId();
    await inTenant(as(a), (tx) => invitationRepository(tx).renew(written.invitation.id, { tokenHash: freshToken().hash, mailTicket: later, ttlSeconds: TTL_SECONDS }));
    const [renewed] = await rowsOf(a.workspaceId);
    const stale = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, invitation.mailTicket, freshToken().hash));
    const unchanged = (await rowsOf(a.workspaceId))[0]?.token_hash;
    const issued = freshToken().hash;
    const current = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, later, issued));

    expect(stale).toBeUndefined();
    expect(unchanged?.equals(renewed?.token_hash ?? Buffer.alloc(0))).toBe(true);
    expect(current).toBeDefined();
    expect((await rowsOf(a.workspaceId))[0]?.token_hash.equals(issued)).toBe(true);
  });

  it("replaces the ticket when writing an invitation for an address that already has a pending one", async () => {
    const a = await workspaceOf("owner");
    const first = newInvitation("again@example.test");
    const second = newInvitation("again@example.test");
    await inTenant(as(a), (tx) => invitationRepository(tx).writePending(first));
    const written = await inTenant(as(a), (tx) => invitationRepository(tx).writePending(second));

    const stale = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, first.mailTicket, freshToken().hash));
    const current = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(written.invitation.id, second.mailTicket, freshToken().hash));

    expect(written.resent).toBe(true);
    expect(stale).toBeUndefined();
    expect(current).toBeDefined();
  });

  it("issues nothing for an invitation that holds no ticket", async () => {
    const a = await workspaceOf("owner");
    const id = await seedInvitation(a.workspaceId, "seeded@example.test");
    const before = await checksum(a.workspaceId);

    const context = await inTenant(as(a), (tx) => invitationRepository(tx).issueToken(id, TICKET, freshToken().hash));

    expect(context).toBeUndefined();
    expect(await checksum(a.workspaceId)).toBe(before);
  });
});

describe("sys_invitation_invitee_locale", () => {
  it("answers the language of the account that holds the invited address, to an admin or owner of the workspace", async () => {
    const a = await workspaceOf("owner", "admin", "member");
    const german = await account({ locale: "de" });
    const english = await account({ locale: "en" });
    const toGerman = await seedInvitation(a.workspaceId, german.email.toUpperCase());
    const toEnglish = await seedInvitation(a.workspaceId, english.email);
    const ask = (index: number, id: string): Promise<string | undefined> => inTenant({ accountId: who(a, index), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).inviteeLocale(id));

    expect(await ask(0, toGerman)).toBe("de");
    expect(await ask(1, toGerman)).toBe("de");
    expect(await ask(1, toEnglish)).toBe("en");
  });

  it("answers nothing for an address no account holds, a member who may not invite, an invitation of another workspace and one that is not pending", async () => {
    const a = await workspaceOf("owner", "member");
    const b = await workspaceOf("owner");
    const german = await account({ locale: "de" });
    const unknown = await seedInvitation(a.workspaceId, "no-account@example.test");
    const own = await seedInvitation(a.workspaceId, german.email);
    const foreign = await seedInvitation(b.workspaceId, german.email);
    const revoked = await seedInvitation(a.workspaceId, german.email, { status: "revoked" });
    const ask = (index: number, id: string): Promise<string | undefined> => inTenant({ accountId: who(a, index), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).inviteeLocale(id));

    expect(await ask(0, unknown)).toBeUndefined();
    expect(await ask(1, own)).toBeUndefined();
    expect(await ask(0, foreign)).toBeUndefined();
    expect(await ask(0, revoked)).toBeUndefined();
    expect(await ask(0, own)).toBe("de");
  });

  it("answers nothing to a transaction that acts in no workspace", async () => {
    const a = await workspaceOf("owner");
    const german = await account({ locale: "de" });
    const id = await seedInvitation(a.workspaceId, german.email);

    const rows = await appAs({ accountId: who(a, 0) }, (tx) => tx<{ locale: string | null }[]>`SELECT public.sys_invitation_invitee_locale(${id}::uuid) AS locale`);

    expect(rows[0]?.locale).toBeNull();
  });
});

describe("the invitations when an account or a workspace goes", () => {
  it("keeps the invitation when the account that sent it is deleted, and clears the sender", async () => {
    const a = await workspaceOf("owner", "admin");
    const written = await inTenant({ accountId: who(a, 1), workspaceId: a.workspaceId }, (tx) => invitationRepository(tx).writePending(newInvitation("kept@example.test")));

    await asSystem(db, (tx) => tx`DELETE FROM accounts WHERE id = ${who(a, 1)}`);

    const [row] = await rowsOf(a.workspaceId);
    expect(row).toMatchObject({ id: written.invitation.id, status: "pending", invited_by: null });
  });

  it("is deleted with its workspace", async () => {
    const a = await workspaceOf("owner");
    await seedInvitation(a.workspaceId, "cascade@example.test");

    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${a.workspaceId}`);

    expect(await rowsOf(a.workspaceId)).toHaveLength(0);
  });
});
