import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The candidates of a slug, the remembered choice and the table behind it (doc 05 sections 2.6 and 4, doc 02 sections 6.2 to 6.4, doc 10 T1, T2 and
// T12). The failure scenario: a member of workspace A resolves and remembers a slug that exists only in workspace B, a bookmark that does not forward, a
// plan-archived one and another member's private bookmark with the same slug, and none of them is a candidate, none can be remembered, and nothing is
// written. The plan of the scan on a workspace of 50 000 bookmarks is in go-resolution-plan.integration.test.ts.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `go-resolution${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly me: string;
  readonly other: string;
}

/** A workspace with two members, `me` and `other`. */
async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Go test" });
  const me = await account();
  const other = await account();
  await seedMember(db, { workspaceId: id, accountId: me, role: "owner" });
  await seedMember(db, { workspaceId: id, accountId: other, role: "member" });
  return { id, me, other };
}

function inTenant<T>(workspaceId: string, accountId: string, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId, workspaceId, requestId: "go-resolution-test" }, work);
}

interface SeedOptions {
  readonly ownerId: string | null;
  readonly slug: string | null;
  readonly forwarding?: boolean;
  readonly archived?: boolean;
  readonly title?: string;
  readonly url?: string;
}

async function seedBookmark(workspaceId: string, options: SeedOptions): Promise<string> {
  const id = freshId();
  const url = options.url ?? "https://example.com/seed";
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, slug, forwarding, plan_archived_at)
      VALUES (${id}, ${workspaceId}, ${options.ownerId}, ${url}, ${url}, 'example.com', ${options.title ?? "Seed"}, ${options.slug},
              ${options.forwarding ?? options.slug !== null}, ${options.archived === true ? new Date() : null})`,
  );
  return id;
}

interface PreferenceRow {
  readonly workspace_id: string;
  readonly account_id: string;
  readonly slug: string;
  readonly bookmark_id: string;
}

async function preferences(workspaceId: string): Promise<PreferenceRow[]> {
  return asSystem(db, (tx) => tx<PreferenceRow[]>`SELECT workspace_id, account_id, slug, bookmark_id FROM slug_preferences WHERE workspace_id = ${workspaceId} ORDER BY account_id, slug`);
}

async function slugsSeenBy(workspaceId: string, accountId: string): Promise<string[]> {
  const rows = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true), set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx<{ slug: string }[]>`SELECT slug FROM slug_preferences`;
  });
  return rows.map((row) => row.slug);
}

async function failureCode(work: Promise<unknown>): Promise<string | undefined> {
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

describe("the table", () => {
  it("has the key, the two cascading keys, the grammar check and a policy that is enabled and forced", async () => {
    const constraints = await db.owner<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.slug_preferences'::regclass ORDER BY conname`;
    const definitions = Object.fromEntries(constraints.map((row) => [row.conname, row.def]));
    expect(definitions["slug_preferences_pkey"]).toBe("PRIMARY KEY (workspace_id, account_id, slug)");
    expect(definitions["slug_preferences_bookmark_fkey"]).toBe("FOREIGN KEY (workspace_id, bookmark_id) REFERENCES bookmarks(workspace_id, id) ON DELETE CASCADE");
    expect(definitions["slug_preferences_member_fkey"]).toBe("FOREIGN KEY (workspace_id, account_id) REFERENCES workspace_members(workspace_id, account_id) ON DELETE CASCADE");
    expect(definitions["slug_preferences_slug_check"]).toContain("^[a-z0-9][a-z0-9-]{0,63}$");
    const [table] = await db.owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.slug_preferences'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const [policy] = await db.owner<{ policyname: string; qual: string; with_check: string }[]>`SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'slug_preferences'`;
    expect(policy?.policyname).toBe("slug_preferences_tenant");
    expect(policy?.qual).toBe("((workspace_id = app_workspace_id()) AND (account_id = app_account_id()))");
    expect(policy?.with_check).toBe(policy?.qual);
    const [slug] = await db.owner<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns WHERE table_name = 'slug_preferences' AND column_name = 'slug'`;
    expect(slug?.data_type).toBe("text");
  });

  it("gives slugbase_app no way to delete a preference or to change what it belongs to", async () => {
    const [privileges] = await db.owner<{ select: boolean; insert: boolean; update: boolean; remove: boolean; slug_update: boolean; bookmark_update: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.slug_preferences', 'SELECT') AS select,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'INSERT') AS insert,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'UPDATE') AS update,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'DELETE') AS remove,
             has_column_privilege('slugbase_app', 'public.slug_preferences', 'slug', 'UPDATE') AS slug_update,
             has_column_privilege('slugbase_app', 'public.slug_preferences', 'bookmark_id', 'UPDATE') AS bookmark_update`;
    expect(privileges).toEqual({ select: true, insert: false, update: false, remove: false, slug_update: false, bookmark_update: true });
  });
});

describe("the candidates of a slug", () => {
  it("are the caller's own forwarding, non-archived bookmarks with the slug, with the address and nothing of anyone else's", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", url: "https://mail.example.com/inbox" });

    const found = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }));

    expect(found).toEqual({ candidates: [{ id: mine, ownerId: workspace.me, url: "https://mail.example.com/inbox", access: "owner" }], preferredId: undefined });
  });

  it("leave out another workspace's bookmark, one that does not forward, an archived one, another member's private one, an ownerless one and one with another slug", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "only-in-b" });
    await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "paused", forwarding: false });
    await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "archived", archived: true });
    await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "private" });
    await seedBookmark(workspace.id, { ownerId: null, slug: "ownerless" });
    await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mailbox" });

    for (const slug of ["only-in-b", "paused", "archived", "private", "ownerless", "mail"]) {
      const found = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug, accountId: workspace.me }));
      expect(found, slug).toEqual({ candidates: [], preferredId: undefined });
    }
  });

  it("are each member's own when two members have the same slug, and the caller sees only theirs", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "My mail" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "Their mail" });

    const forMe = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }));
    const forThem = await inTenant(workspace.id, workspace.other, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.other }));

    expect(forMe.candidates.map((candidate) => candidate.id)).toEqual([mine]);
    expect(forThem.candidates.map((candidate) => candidate.id)).toEqual([theirs]);
  });

  it("are read for the account of the transaction only, and only in a transaction opened with a workspace", async () => {
    const workspace = await workspaceOf();

    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.other }))).rejects.toThrow("only the account of the transaction");
    await expect(db.tenant.withTenant({ accountId: workspace.me, requestId: "go-resolution-test" }, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }))).rejects.toBeInstanceOf(TenantContextError);
  });

  it("carry the remembered choice of the caller and of nobody else", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me }))).toBe(true);

    const forMe = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }));
    const forThem = await inTenant(workspace.id, workspace.other, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.other }));
    expect(forMe.preferredId).toBe(mine);
    expect(forThem.preferredId).toBeUndefined();
  });
});

describe("remembering a choice", () => {
  it("stores one preference for the account and the slug, and choosing again leaves it as it is", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const inbox = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "inbox" });

    await inTenant(workspace.id, workspace.me, async (tx) => {
      const repository = goRepository(tx);
      expect(await repository.remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me })).toBe(true);
      expect(await repository.remember({ slug: "inbox", bookmarkId: inbox, accountId: workspace.me })).toBe(true);
      expect(await repository.remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me })).toBe(true);
    });

    expect((await preferences(workspace.id)).map((row) => [row.slug, row.bookmark_id])).toEqual([
      ["inbox", inbox],
      ["mail", mine],
    ]);
  });

  it("replaces the bookmark of an earlier choice for the same slug", async () => {
    const workspace = await workspaceOf();
    const stale = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    // A choice that is no longer a candidate (the bookmark was shared with the member and no longer is): the row stays until it is replaced.
    await asSystem(db, (tx) => tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspace.id}, ${workspace.me}, 'mail', ${stale})`);
    expect((await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }))).preferredId).toBe(stale);

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me }))).toBe(true);

    expect((await preferences(workspace.id)).map((row) => row.bookmark_id)).toEqual([mine]);
  });

  it("writes nothing for a bookmark that is no candidate of the slug for the caller", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "mail" });
    const others = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });
    const paused = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "paused", forwarding: false });
    const archived = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "archived", archived: true });
    const ownerless = await seedBookmark(workspace.id, { ownerId: null, slug: "ownerless" });
    const attempts: readonly [string, string][] = [
      ["mail", inElsewhere],
      ["mail", others],
      ["paused", paused],
      ["archived", archived],
      ["ownerless", ownerless],
      ["inbox", mine],
      ["mail", freshId()],
    ];

    for (const [slug, bookmarkId] of attempts) {
      const done = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug, bookmarkId, accountId: workspace.me }));
      expect(done, `${slug} ${bookmarkId}`).toBe(false);
    }

    expect(await preferences(workspace.id)).toEqual([]);
    expect(await preferences(elsewhere.id)).toEqual([]);
  });

  it("makes one preference when the same choice is made twice at once", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me }))),
    );

    expect(results).toEqual(Array<boolean>(6).fill(true));
    expect((await preferences(workspace.id)).map((row) => row.bookmark_id)).toEqual([mine]);
  });

  it("is forgotten with its bookmark and with its member", async () => {
    const workspace = await workspaceOf();
    const withBookmark = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "gone" });
    const withMember = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "leaves" });
    await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "gone", bookmarkId: withBookmark, accountId: workspace.me }));
    await inTenant(workspace.id, workspace.other, (tx) => goRepository(tx).remember({ slug: "leaves", bookmarkId: withMember, accountId: workspace.other }));
    expect(await preferences(workspace.id)).toHaveLength(2);

    await asSystem(db, (tx) => tx`DELETE FROM bookmarks WHERE id = ${withBookmark}`);
    expect((await preferences(workspace.id)).map((row) => row.slug)).toEqual(["leaves"]);

    await asSystem(db, (tx) => tx`DELETE FROM workspace_members WHERE workspace_id = ${workspace.id} AND account_id = ${workspace.other}`);
    expect(await preferences(workspace.id)).toEqual([]);
  });

  it("is refused for another account than the one of the transaction and for a malformed identifier", async () => {
    const workspace = await workspaceOf();

    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: freshId(), accountId: workspace.other }))).rejects.toThrow("only the account of the transaction");
    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: "x'; DROP TABLE bookmarks; --", accountId: workspace.me }))).rejects.toThrow("takes identifiers only");
  });
});

describe("the policy of the table", () => {
  it("shows a member their own preferences of the workspace and refuses a row for another account, another workspace, or a slug outside the grammar", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "theirs" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "mail" });
    await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me }));
    await inTenant(workspace.id, workspace.other, (tx) => goRepository(tx).remember({ slug: "theirs", bookmarkId: theirs, accountId: workspace.other }));
    await inTenant(elsewhere.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: inElsewhere, accountId: workspace.me }));

    const visible = await slugsSeenBy(workspace.id, workspace.me);
    expect(visible).toEqual(["mail"]);
    expect(await slugsSeenBy(workspace.id, workspace.other)).toEqual(["theirs"]);
    const withoutWorkspace = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${workspace.me}, true)`;
      return tx<{ slug: string }[]>`SELECT slug FROM slug_preferences`;
    });
    expect(withoutWorkspace).toEqual([]);

    const insertFor = (workspaceId: string, accountId: string, actingAs: string, bookmarkId: string, slug: string) =>
      db.app.begin(async (tx) => {
        await tx`SELECT set_config('app.account_id', ${actingAs}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
        await tx`INSERT INTO slug_preferences (workspace_id, account_id, slug, bookmark_id) VALUES (${workspaceId}, ${accountId}, ${slug}, ${bookmarkId})`;
      });
    expect(await failureCode(insertFor(workspace.id, workspace.other, workspace.me, theirs, "other-account"))).toBe(ROW_LEVEL_SECURITY);
    expect(await failureCode(insertFor(elsewhere.id, workspace.me, workspace.me, inElsewhere, "other-workspace"))).toBe(ROW_LEVEL_SECURITY);
    expect(await failureCode(insertFor(workspace.id, workspace.me, workspace.me, mine, "Not A Slug"))).toBe("23514");
  });

  it("lets a member change no preference but their own", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId: mine, accountId: workspace.me }));
    const decoy = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "decoy" });

    const updated = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${workspace.other}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx`UPDATE slug_preferences SET bookmark_id = ${decoy} WHERE slug = 'mail' RETURNING slug`;
    });

    expect(updated).toHaveLength(0);
    expect((await preferences(workspace.id)).map((row) => row.bookmark_id)).toEqual([mine]);
  });
});

describe("the summaries of candidates", () => {
  it("name the title, the host and the owner of the caller's readable bookmarks and leave out the others", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "Mail" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "theirs", title: "Theirs" });
    const ownerless = await seedBookmark(workspace.id, { ownerId: null, slug: "nobody", title: "Nobody's" });

    const summaries = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).summaries([mine, theirs, ownerless, freshId()]));

    expect(summaries).toEqual([expect.objectContaining({ id: mine, title: "Mail", host: "example.com", ownerId: workspace.me })]);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).summaries([]))).toEqual([]);
  });
});
