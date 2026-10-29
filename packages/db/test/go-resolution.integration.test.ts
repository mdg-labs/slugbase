import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSlug } from "@slugbase/core";
import { goRepository, TenantContextError } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedTeam, shareBookmark, shareThroughFolder } from "./support/share-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The candidates of a slug, the remembered choice and the table behind it (doc 05 sections 2.6 and 4, doc 02 sections 6.2 to 6.4, doc 10 T1, T2 and
// T12). The failure scenario: a member of workspace A resolves and remembers a slug that exists only in workspace B, a bookmark that does not forward, a
// plan-archived one and another member's private bookmark with the same slug, and none of them is a candidate, none can be remembered, and nothing is
// written. A remembered choice is forgotten with its bookmark, and ignored and deleted on the next resolution once its bookmark has another slug, has stopped
// forwarding or can no longer be read (doc 02 section 6.4): the scenario is a choice for `mail` on a bookmark that is then renamed to `post`. The plan of the scan on a workspace of 50 000 bookmarks is in go-resolution-plan.integration.test.ts.

const HOOK_TIMEOUT_MS = 300_000;
const ROW_LEVEL_SECURITY = "42501";

let db: TestDatabase;

/** A matcher for an object that has at least these fields. */
const like = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields);

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

  it("lets slugbase_app delete a preference, and gives it no way to change what it belongs to", async () => {
    const [privileges] = await db.owner<{ select: boolean; insert: boolean; update: boolean; remove: boolean; slug_update: boolean; bookmark_update: boolean }[]>`
      SELECT has_table_privilege('slugbase_app', 'public.slug_preferences', 'SELECT') AS select,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'INSERT') AS insert,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'UPDATE') AS update,
             has_table_privilege('slugbase_app', 'public.slug_preferences', 'DELETE') AS remove,
             has_column_privilege('slugbase_app', 'public.slug_preferences', 'slug', 'UPDATE') AS slug_update,
             has_column_privilege('slugbase_app', 'public.slug_preferences', 'bookmark_id', 'UPDATE') AS bookmark_update`;
    expect(privileges).toEqual({ select: true, insert: false, update: false, remove: true, slug_update: false, bookmark_update: true });
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

describe("the candidates of a slug that others share with the caller (T12)", () => {
  function candidatesOf(workspace: Workspace, accountId: string, slug = "mail") {
    return inTenant(workspace.id, accountId, (tx) => goRepository(tx).candidates({ slug, accountId }));
  }

  it("include the bookmark shared directly, through a team, through a folder and through a folder shared with a team, each with the route that gives it and the owner's address", async () => {
    const workspace = await workspaceOf();
    const team = await seedTeam(db, workspace.id, [workspace.me]);
    const direct = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "direct", url: "https://example.com/direct" });
    const viaTeam = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "team", url: "https://example.com/team" });
    const viaFolder = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "folder", url: "https://example.com/folder" });
    const viaTeamFolder = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "teamfolder", url: "https://example.com/teamfolder" });
    await shareBookmark(db, workspace.id, direct, workspace.other, { accountId: workspace.me });
    await shareBookmark(db, workspace.id, viaTeam, workspace.other, { teamId: team });
    await shareThroughFolder(db, workspace.id, viaFolder, workspace.other, { accountId: workspace.me });
    await shareThroughFolder(db, workspace.id, viaTeamFolder, workspace.other, { teamId: team });

    expect((await candidatesOf(workspace, workspace.me, "direct")).candidates).toEqual([{ id: direct, ownerId: workspace.other, url: "https://example.com/direct", access: "direct" }]);
    expect((await candidatesOf(workspace, workspace.me, "team")).candidates).toEqual([{ id: viaTeam, ownerId: workspace.other, url: "https://example.com/team", access: "team" }]);
    expect((await candidatesOf(workspace, workspace.me, "folder")).candidates).toEqual([{ id: viaFolder, ownerId: workspace.other, url: "https://example.com/folder", access: "folder" }]);
    expect((await candidatesOf(workspace, workspace.me, "teamfolder")).candidates).toEqual([{ id: viaTeamFolder, ownerId: workspace.other, url: "https://example.com/teamfolder", access: "folder" }]);
  });

  it("name a bookmark that two routes give once, by the first route in the order direct, team, folder", async () => {
    const workspace = await workspaceOf();
    const team = await seedTeam(db, workspace.id, [workspace.me]);
    const both = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });
    await shareThroughFolder(db, workspace.id, both, workspace.other, { accountId: workspace.me });
    await shareBookmark(db, workspace.id, both, workspace.other, { teamId: team });

    expect((await candidatesOf(workspace, workspace.me)).candidates).toEqual([like({ id: both, access: "team" })]);
    await shareBookmark(db, workspace.id, both, workspace.other, { accountId: workspace.me });
    expect((await candidatesOf(workspace, workspace.me)).candidates).toEqual([like({ id: both, access: "direct" })]);
  });

  it("leave out a shared bookmark that does not forward, an archived one, one shared with another member, one shared with a team the caller is not in, one in a folder shared with that team and one shared in another workspace", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    // A slug is unique among one member's bookmarks, so each bookmark with the slug below is a different member's.
    const colleague = async (): Promise<string> => {
      const accountId = await account();
      await seedMember(db, { workspaceId: workspace.id, accountId, role: "member" });
      return accountId;
    };
    const stranger = await colleague();
    const otherTeam = await seedTeam(db, workspace.id, [stranger, workspace.other]);
    const [pausedBy, archivedBy, strangerBy, teamBy, teamFolderBy, unsharedFolderBy] = [await colleague(), await colleague(), await colleague(), await colleague(), await colleague(), await colleague()];
    const paused = await seedBookmark(workspace.id, { ownerId: pausedBy, slug: "mail", forwarding: false });
    const archived = await seedBookmark(workspace.id, { ownerId: archivedBy, slug: "mail", archived: true });
    const forStranger = await seedBookmark(workspace.id, { ownerId: strangerBy, slug: "mail" });
    const forOtherTeam = await seedBookmark(workspace.id, { ownerId: teamBy, slug: "mail" });
    const inOtherTeamsFolder = await seedBookmark(workspace.id, { ownerId: teamFolderBy, slug: "mail" });
    const filedUnshared = await seedBookmark(workspace.id, { ownerId: unsharedFolderBy, slug: "mail" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: elsewhere.other, slug: "mail" });
    await shareBookmark(db, workspace.id, paused, pausedBy, { accountId: workspace.me });
    await shareBookmark(db, workspace.id, archived, archivedBy, { accountId: workspace.me });
    await shareBookmark(db, workspace.id, forStranger, strangerBy, { accountId: stranger });
    await shareBookmark(db, workspace.id, forOtherTeam, teamBy, { teamId: otherTeam });
    await shareThroughFolder(db, workspace.id, inOtherTeamsFolder, teamFolderBy, { teamId: otherTeam });
    await asSystem(db, async (tx) => {
      const folder = freshId();
      await tx`INSERT INTO folders (id, workspace_id, owner_id, name) VALUES (${folder}, ${workspace.id}, ${unsharedFolderBy}, 'Not shared')`;
      await tx`INSERT INTO folder_bookmarks (workspace_id, folder_id, bookmark_id) VALUES (${workspace.id}, ${folder}, ${filedUnshared})`;
    });
    await shareBookmark(db, elsewhere.id, inElsewhere, elsewhere.other, { accountId: workspace.me });

    expect(await candidatesOf(workspace, workspace.me)).toEqual({ candidates: [], preferredId: undefined });
    for (const bookmarkId of [paused, archived, forStranger, forOtherTeam, inOtherTeamsFolder, filedUnshared, inElsewhere]) {
      expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).remember({ slug: "mail", bookmarkId, accountId: workspace.me })), bookmarkId).toBe(false);
    }
    expect(await preferences(workspace.id)).toEqual([]);
    expect((await candidatesOf(workspace, stranger)).candidates.map((candidate) => candidate.id).toSorted()).toEqual([forStranger, forOtherTeam, inOtherTeamsFolder].toSorted());
  });

  it("stop at the end of the share: a revoked share, a member who left the team and a bookmark taken out of the shared folder", async () => {
    const workspace = await workspaceOf();
    const team = await seedTeam(db, workspace.id, [workspace.me]);
    const shared = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "direct" });
    const viaTeam = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "team" });
    const viaFolder = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "folder" });
    await shareBookmark(db, workspace.id, shared, workspace.other, { accountId: workspace.me });
    await shareBookmark(db, workspace.id, viaTeam, workspace.other, { teamId: team });
    const folder = await shareThroughFolder(db, workspace.id, viaFolder, workspace.other, { accountId: workspace.me });
    for (const slug of ["direct", "team", "folder"]) {
      expect((await candidatesOf(workspace, workspace.me, slug)).candidates, slug).toHaveLength(1);
    }

    await asSystem(db, async (tx) => {
      await tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${shared}`;
      await tx`DELETE FROM team_members WHERE team_id = ${team}`;
      await tx`DELETE FROM folder_bookmarks WHERE folder_id = ${folder}`;
    });

    for (const slug of ["direct", "team", "folder"]) {
      expect((await candidatesOf(workspace, workspace.me, slug)).candidates, slug).toEqual([]);
    }
  });

  it("are the caller's own and the shared ones together, and the caller's choice among them can be remembered and is forgotten when the access ends", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "Mine" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "Theirs" });
    await shareBookmark(db, workspace.id, theirs, workspace.other, { accountId: workspace.me });

    const found = await candidatesOf(workspace, workspace.me);
    expect(found.candidates.map((candidate) => [candidate.id, candidate.access]).toSorted()).toEqual([[mine, "owner"], [theirs, "direct"]].toSorted());
    await rememberFor(workspace, workspace.me, "mail", theirs);
    expect((await candidatesOf(workspace, workspace.me)).preferredId).toBe(theirs);
    expect((await candidatesOf(workspace, workspace.other)).candidates).toEqual([like({ id: theirs, access: "owner" })]);

    await asSystem(db, (tx) => tx`DELETE FROM bookmark_shares WHERE bookmark_id = ${theirs}`);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: theirs, accountId: workspace.me }))).toBe(true);
    expect(await preferences(workspace.id)).toEqual([]);
  });

  it("name the shared bookmark's title, host and owner in the summaries, and none of an unshared one", async () => {
    const workspace = await workspaceOf();
    const shared = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "Shared mail" });
    const unshared = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "private", title: "Private" });
    await shareBookmark(db, workspace.id, shared, workspace.other, { accountId: workspace.me });

    const summaries = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).summaries([shared, unshared]));

    expect(summaries).toEqual([like({ id: shared, title: "Shared mail", ownerId: workspace.other, ownerName: expect.any(String) as string })]);
  });
});

describe("the resolution of a slug through the store, with shared candidates (Q25)", () => {
  function resolve(workspace: Workspace, accountId: string, slug = "mail") {
    return db.tenant.withTenant({ accountId, workspaceId: workspace.id, requestId: "go-resolution-test" }, (tx) => resolveSlug({ store: goRepository(tx) }, { accountId, slug }));
  }

  it("keeps a shared `mail` from breaking the caller's own `mail`", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "Mine" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "Theirs" });
    await shareBookmark(db, workspace.id, theirs, workspace.other, { accountId: workspace.me });

    expect(await resolve(workspace, workspace.me)).toEqual({ kind: "single", bookmark: like({ id: mine, sharedVia: null, owner: null }) });
  });

  it("follows the one shared candidate, and offers several shared ones with their title, host, owner and route", async () => {
    const workspace = await workspaceOf();
    const third = await account();
    await seedMember(db, { workspaceId: workspace.id, accountId: third, role: "member" });
    const team = await seedTeam(db, workspace.id, [workspace.me]);
    const first = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "B mail" });
    const second = await seedBookmark(workspace.id, { ownerId: third, slug: "mail", title: "A mail" });
    await shareBookmark(db, workspace.id, first, workspace.other, { accountId: workspace.me });

    expect(await resolve(workspace, workspace.me)).toEqual({ kind: "single", bookmark: like({ id: first, sharedVia: "direct", owner: { accountId: workspace.other, displayName: expect.any(String) as string } }) });

    await shareBookmark(db, workspace.id, second, third, { teamId: team });
    const several = await resolve(workspace, workspace.me);

    expect(several).toEqual({
      kind: "multiple",
      candidates: [
        like({ id: second, title: "A mail", host: "example.com", sharedVia: "team", owner: { accountId: third, displayName: expect.any(String) as string } }),
        like({ id: first, title: "B mail", host: "example.com", sharedVia: "direct", owner: { accountId: workspace.other, displayName: expect.any(String) as string } }),
      ],
    });
  });

  it("prefers the remembered shared bookmark over the caller's own, and finds nothing where nothing readable has the slug", async () => {
    const workspace = await workspaceOf();
    await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "Mine" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail", title: "Theirs" });
    await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "private", title: "Private" });
    await shareBookmark(db, workspace.id, theirs, workspace.other, { accountId: workspace.me });
    await rememberFor(workspace, workspace.me, "mail", theirs);

    expect(await resolve(workspace, workspace.me)).toEqual({ kind: "preferred", bookmark: like({ id: theirs, sharedVia: "direct" }) });
    expect(await resolve(workspace, workspace.me, "private")).toEqual({ kind: "none", otherWorkspaces: [] });
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

    expect(summaries).toEqual([like({ id: mine, title: "Mail", host: "example.com", ownerId: workspace.me })]);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).summaries([]))).toEqual([]);
  });
});

async function rememberFor(workspace: Workspace, accountId: string, slug: string, bookmarkId: string): Promise<void> {
  expect(await inTenant(workspace.id, accountId, (tx) => goRepository(tx).remember({ slug, bookmarkId, accountId }))).toBe(true);
}

describe("a remembered choice whose bookmark has stopped being a candidate", () => {
  it("survives the rename of its bookmark until the slug is resolved, and then the resolution finds it and forgets it", async () => {
    const workspace = await workspaceOf();
    const renamed = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    await rememberFor(workspace, workspace.me, "mail", renamed);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET slug = 'post' WHERE id = ${renamed}`);
    expect((await preferences(workspace.id)).map((row) => [row.slug, row.bookmark_id])).toEqual([["mail", renamed]]);

    const found = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }));
    expect(found).toEqual({ candidates: [], preferredId: renamed });
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: renamed, accountId: workspace.me }))).toBe(true);

    expect(await preferences(workspace.id)).toEqual([]);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).candidates({ slug: "mail", accountId: workspace.me }))).toEqual({ candidates: [], preferredId: undefined });
  });

  it.each([
    ["has another slug", `UPDATE bookmarks SET slug = 'post' WHERE id = $1`],
    ["has stopped forwarding", `UPDATE bookmarks SET forwarding = false WHERE id = $1`],
    ["has lost its slug", `UPDATE bookmarks SET slug = NULL, forwarding = false WHERE id = $1`],
    ["is no longer readable by the member (another owner)", `UPDATE bookmarks SET owner_id = (SELECT account_id FROM workspace_members WHERE workspace_id = bookmarks.workspace_id AND account_id <> $2 LIMIT 1) WHERE id = $1`],
    ["is no longer readable by the member (no owner)", `UPDATE bookmarks SET owner_id = NULL WHERE id = $1`],
  ])("is forgotten when its bookmark %s", async (_reason, change) => {
    const workspace = await workspaceOf();
    const chosen = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    await rememberFor(workspace, workspace.me, "mail", chosen);
    await asSystem(db, (tx) => tx.unsafe(change, change.includes("$2") ? [chosen, workspace.me] : [chosen]));

    const forgotten = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: chosen, accountId: workspace.me }));

    expect(forgotten).toBe(true);
    expect(await preferences(workspace.id)).toEqual([]);
  });

  it("is kept while it is still a candidate, and while its bookmark is only plan-archived", async () => {
    const workspace = await workspaceOf();
    const live = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const archived = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "later" });
    await rememberFor(workspace, workspace.me, "mail", live);
    await rememberFor(workspace, workspace.me, "later", archived);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived}`);

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: live, accountId: workspace.me }))).toBe(false);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "later", bookmarkId: archived, accountId: workspace.me }))).toBe(false);

    expect((await preferences(workspace.id)).map((row) => row.slug)).toEqual(["later", "mail"]);
  });

  it("is not deleted for a bookmark it no longer names, so a choice made again in the meantime stays", async () => {
    const workspace = await workspaceOf();
    const stale = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const again = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail-again" });
    await rememberFor(workspace, workspace.me, "mail", stale);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET slug = 'post' WHERE id = ${stale}`);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET slug = 'mail' WHERE id = ${again}`);
    await rememberFor(workspace, workspace.me, "mail", again);

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: stale, accountId: workspace.me }))).toBe(false);

    expect((await preferences(workspace.id)).map((row) => row.bookmark_id)).toEqual([again]);
  });

  it("is forgotten for the account of the transaction only, and a choice of another member for the same slug stays", async () => {
    const workspace = await workspaceOf();
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });
    await rememberFor(workspace, workspace.me, "mail", mine);
    await rememberFor(workspace, workspace.other, "mail", theirs);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET slug = 'post' WHERE id IN (${mine}, ${theirs})`);

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: theirs, accountId: workspace.me }))).toBe(false);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: mine, accountId: workspace.me }))).toBe(true);

    expect((await preferences(workspace.id)).map((row) => [row.account_id, row.bookmark_id])).toEqual([[workspace.other, theirs]]);
    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetStale({ slug: "mail", bookmarkId: theirs, accountId: workspace.other }))).rejects.toThrow("only the account of the transaction");
  });
});

describe("the remembered choices of a member", () => {
  it("are listed with the bookmark they name, in the order of the slugs, and only those whose bookmark is still a candidate", async () => {
    const workspace = await workspaceOf();
    const inbox = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "inbox", title: "Inbox", url: "https://mail.example.com/secret-path" });
    const mail = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail", title: "Mail" });
    const renamed = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "old" });
    const paused = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "paused" });
    const archived = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "archived" });
    for (const [slug, id] of [["mail", mail], ["inbox", inbox], ["old", renamed], ["paused", paused], ["archived", archived]] as const) {
      await rememberFor(workspace, workspace.me, slug, id);
    }
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET slug = 'new' WHERE id = ${renamed}`);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET forwarding = false WHERE id = ${paused}`);
    await asSystem(db, (tx) => tx`UPDATE bookmarks SET plan_archived_at = now() WHERE id = ${archived}`);

    const listed = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).listPreferences({ accountId: workspace.me, afterSlug: undefined, limit: 10 }));

    expect(listed.map(({ slug, bookmarkId, title, host, ownerId }) => ({ slug, bookmarkId, title, host, ownerId }))).toEqual([
      { slug: "inbox", bookmarkId: inbox, title: "Inbox", host: "example.com", ownerId: workspace.me },
      { slug: "mail", bookmarkId: mail, title: "Mail", host: "example.com", ownerId: workspace.me },
    ]);
    expect(listed.every((row) => row.ownerName !== null)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("secret-path");
  });

  it("are listed in pages that follow the slug, hyphens and digits included, whatever the collation", async () => {
    const workspace = await workspaceOf();
    const slugs = ["a-b", "a1", "ab", "b", "0a", "a-a"];
    for (const slug of slugs) {
      await rememberFor(workspace, workspace.me, slug, await seedBookmark(workspace.id, { ownerId: workspace.me, slug }));
    }

    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const listed = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).listPreferences({ accountId: workspace.me, afterSlug: after, limit: 2 }));
      seen.push(...listed.map((row) => row.slug));
      after = listed.at(-1)?.slug;
      if (listed.length < 2) {
        break;
      }
    }

    expect(seen).toEqual([...slugs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("are the caller's alone: another member's choices, and another workspace's, are not listed", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "theirs" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "elsewhere" });
    await rememberFor(workspace, workspace.me, "mail", mine);
    await rememberFor(workspace, workspace.other, "theirs", theirs);
    await rememberFor(elsewhere, workspace.me, "elsewhere", inElsewhere);

    const listed = await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).listPreferences({ accountId: workspace.me, afterSlug: undefined, limit: 10 }));

    expect(listed.map((row) => row.slug)).toEqual(["mail"]);
    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).listPreferences({ accountId: workspace.other, afterSlug: undefined, limit: 10 }))).rejects.toThrow("only the account of the transaction");
    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).listPreferences({ accountId: workspace.me, afterSlug: undefined, limit: 0 }))).rejects.toThrow("positive whole limit");
    await expect(db.tenant.withTenant({ accountId: workspace.me, requestId: "go-resolution-test" }, (tx) => goRepository(tx).listPreferences({ accountId: workspace.me, afterSlug: undefined, limit: 10 }))).rejects.toBeInstanceOf(TenantContextError);
  });

  it("are forgotten one at a time, for the caller's own slug only", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    const mail = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const inbox = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "inbox" });
    const theirs = await seedBookmark(workspace.id, { ownerId: workspace.other, slug: "mail" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "mail" });
    await rememberFor(workspace, workspace.me, "mail", mail);
    await rememberFor(workspace, workspace.me, "inbox", inbox);
    await rememberFor(workspace, workspace.other, "mail", theirs);
    await rememberFor(elsewhere, workspace.me, "mail", inElsewhere);

    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetPreference({ slug: "mail", accountId: workspace.me }))).toBe(true);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetPreference({ slug: "mail", accountId: workspace.me }))).toBe(false);
    expect(await inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetPreference({ slug: "unknown", accountId: workspace.me }))).toBe(false);

    expect((await preferences(workspace.id)).map((row) => [row.account_id, row.slug])).toEqual(
      [[workspace.me, "inbox"], [workspace.other, "mail"]].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "")),
    );
    expect((await preferences(elsewhere.id)).map((row) => row.slug)).toEqual(["mail"]);
    await expect(inTenant(workspace.id, workspace.me, (tx) => goRepository(tx).forgetPreference({ slug: "mail", accountId: workspace.other }))).rejects.toThrow("only the account of the transaction");
  });

  it("cannot be deleted by another member, nor from another workspace, by a statement that names them", async () => {
    const workspace = await workspaceOf();
    const elsewhere = await workspaceOf();
    await seedMember(db, { workspaceId: elsewhere.id, accountId: workspace.me, role: "member" });
    const mine = await seedBookmark(workspace.id, { ownerId: workspace.me, slug: "mail" });
    const inElsewhere = await seedBookmark(elsewhere.id, { ownerId: workspace.me, slug: "mail" });
    await rememberFor(workspace, workspace.me, "mail", mine);
    await rememberFor(elsewhere, workspace.me, "mail", inElsewhere);

    const asOther = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${workspace.other}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx`DELETE FROM slug_preferences WHERE slug = 'mail' RETURNING slug`;
    });
    const fromWorkspaceOfAnother = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${workspace.me}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx`DELETE FROM slug_preferences WHERE workspace_id = ${elsewhere.id} RETURNING slug`;
    });

    expect(asOther).toHaveLength(0);
    expect(fromWorkspaceOfAnother).toHaveLength(0);
    expect(await preferences(workspace.id)).toHaveLength(1);
    expect(await preferences(elsewhere.id)).toHaveLength(1);
  });
});
