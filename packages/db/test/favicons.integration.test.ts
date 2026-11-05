import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { faviconRepository, TenantContextError, type FaviconResult } from "../src/index.ts";
import { enqueueInTenantTransaction } from "../src/system/queue.ts";
import { tenantHandle } from "../src/tenant.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, seedAccount } from "./support/auth-fixture.ts";
import { seedMember, seedWorkspace } from "./support/workspace-fixture.ts";

// The favicon cache and the two system operations behind it (doc 05 sections 2.7 and 3.3, doc 02 section 5.4, doc 10 T6 and T14). The failure scenario: the
// table is deployment-wide and has no tenant policy, so the application role must reach it through `sys_favicon_get` and `sys_favicon_put` alone, and the
// put must refuse anything that is not a PNG, a host that is not a lower-case host name and a row that breaks the pairing of status and content, so nothing but a
// PNG of at most 64 KiB is ever served for a host. The stored images are shared but what a workspace is answered is its own: `workspace_favicons` records the
// fetches stored for a workspace, a member of another workspace reads nothing from a host only the first workspace fetched, and with the application's predicates left out
// row-level security still shows a workspace nothing of another's. The question of which hosts a member may have fetched is tenant-scoped: a bookmark of the active workspace
// that the account can read, and no other.

const HOOK_TIMEOUT_MS = 300_000;
const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PARAMETER = "22023";
const ROW_LEVEL_SECURITY = "42501";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const QUEUE = "favicon.fetch";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.owner.unsafe(`
    CREATE TABLE pgboss.queue (
      name text PRIMARY KEY, retention_seconds int NOT NULL, expire_seconds int NOT NULL, deletion_seconds int NOT NULL,
      retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL, retry_delay_max int,
      policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE TABLE pgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, data jsonb, singleton_key text, state text NOT NULL DEFAULT 'created',
      keep_until timestamptz NOT NULL, expire_seconds int NOT NULL,
      deletion_seconds int NOT NULL, retry_limit int NOT NULL, retry_delay int NOT NULL, retry_backoff boolean NOT NULL,
      retry_delay_max int, policy text NOT NULL, dead_letter text, heartbeat_seconds int);
    CREATE UNIQUE INDEX job_i1 ON pgboss.job (name, COALESCE(singleton_key, '')) WHERE state = 'created' AND policy = 'short';
    INSERT INTO pgboss.queue VALUES ('${QUEUE}', 3600, 900, 3600, 3, 5, true, NULL, 'short', NULL, NULL);`);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.drop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await asSystem(db, (tx) => tx`DELETE FROM favicons`);
  await asSystem(db, (tx) => tx`DELETE FROM workspace_favicons`);
  await db.owner`TRUNCATE pgboss.job`;
});

/** A byte string that starts with the PNG signature, `extra` bytes long after it. */
function png(extra: number, fill = 0x61): Buffer {
  return Buffer.concat([PNG_SIGNATURE, Buffer.alloc(extra, fill)]);
}

const ICON: FaviconResult = { status: "ok", png64: png(64, 0x64), png32: png(32, 0x32) };

let emailNumber = 0;
async function account(): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `favicons${String(emailNumber)}@example.test`, passwordHash: "$argon2id$stub", emailVerified: true });
  return id;
}

interface Workspace {
  readonly id: string;
  readonly owner: string;
}

async function workspaceOf(): Promise<Workspace> {
  const id = await seedWorkspace(db, { name: "Favicon test" });
  const owner = await account();
  await seedMember(db, { workspaceId: id, accountId: owner, role: "owner" });
  return { id, owner };
}

function inTenant<T>(workspace: Workspace, work: Parameters<typeof db.tenant.withTenant<T>>[1]): Promise<T> {
  return db.tenant.withTenant({ accountId: workspace.owner, workspaceId: workspace.id, requestId: "favicons-test" }, work);
}

async function seedBookmark(workspace: Workspace, host: string, options: { ownerId?: string; archived?: boolean } = {}): Promise<void> {
  const url = `https://${host}/page`;
  await asSystem(
    db,
    (tx) => tx`
      INSERT INTO bookmarks (id, workspace_id, owner_id, url, url_canonical, host, title, plan_archived_at)
      VALUES (${freshId()}, ${workspace.id}, ${options.ownerId ?? workspace.owner}, ${url}, ${url}, ${host}, 'Seed', ${options.archived === true ? "2026-01-01T00:00:00Z" : null})`,
  );
}

interface FaviconRow {
  readonly host: string;
  readonly content: Buffer | null;
  readonly content_32: Buffer | null;
  readonly content_type: string;
  readonly status: string;
  readonly fetched_at: Date;
  readonly expires_at: Date;
}

function fetchesOf(workspaceId: string): Promise<string[]> {
  return asSystem(db, (tx) => tx<{ host: string }[]>`SELECT host FROM workspace_favicons WHERE workspace_id = ${workspaceId} ORDER BY host`).then((found) => found.map((row) => row.host));
}

/** Runs `work` as slugbase_app with the settings of withTenant and nothing else: no repository, no application layer. */
async function appAs<T>(workspace: Workspace, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const result = await db.app.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${workspace.owner}, true), set_config('app.workspace_id', ${workspace.id}, true)`;
    return { value: await work(tx) };
  });
  return result.value;
}

function rows(): Promise<FaviconRow[]> {
  return asSystem(db, (tx) => tx<FaviconRow[]>`SELECT * FROM favicons ORDER BY host`).then((found) => [...found]);
}

describe("the favicon of a host", () => {
  it("is stored with both PNGs and the dates of the database clock, and read back at the size asked for", async () => {
    const a = await workspaceOf();

    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    const [row] = await rows();
    expect(row).toMatchObject({ host: "example.com", status: "ok", content_type: "image/png" });
    expect(row?.content?.equals(png(64, 0x64))).toBe(true);
    expect(row?.content_32?.equals(png(32, 0x32))).toBe(true);
    expect(row?.expires_at.getTime()).toBe((row?.fetched_at.getTime() ?? 0) + 7 * 24 * 3600 * 1000);
    const big = await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64));
    const small = await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 32));
    expect(big?.status === "ok" && Buffer.from(big.png).equals(png(64, 0x64))).toBe(true);
    expect(small?.status === "ok" && Buffer.from(small.png).equals(png(32, 0x32))).toBe(true);
  });

  it("is answered to a workspace only after a fetch for it: a member of another workspace reads nothing of what a fetch for the first stored", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));
    await inTenant(a, (tx) => faviconRepository(tx).store("none.example.com", { status: "none" }));

    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toMatchObject({ status: "ok" });
    expect(await inTenant(b, (tx) => faviconRepository(tx).current("example.com", 64))).toBeUndefined();
    expect(await inTenant(b, (tx) => faviconRepository(tx).current("example.com", 32))).toBeUndefined();
    expect(await inTenant(b, (tx) => faviconRepository(tx).current("none.example.com", 64))).toBeUndefined();

    await inTenant(b, (tx) => faviconRepository(tx).store("example.com", ICON));

    expect(await inTenant(b, (tx) => faviconRepository(tx).current("example.com", 64))).toMatchObject({ status: "ok" });
    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toMatchObject({ status: "ok" });
    expect(await fetchesOf(a.id)).toEqual(["example.com", "none.example.com"]);
    expect(await fetchesOf(b.id)).toEqual(["example.com"]);
  });

  it("records the fetch with the dates of the database clock, seven days apart, and renews them when the workspace fetches the host again", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));
    const [first] = await asSystem(db, (tx) => tx<{ fetched_at: Date; expires_at: Date }[]>`SELECT fetched_at, expires_at FROM workspace_favicons WHERE workspace_id = ${a.id}`);
    expect((first?.expires_at.getTime() ?? 0) - (first?.fetched_at.getTime() ?? 0)).toBe(7 * 24 * 3600 * 1000);
    await asSystem(db, (tx) => tx`UPDATE workspace_favicons SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 second'`);
    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toBeUndefined();

    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toMatchObject({ status: "ok" });
    expect(await fetchesOf(a.id)).toEqual(["example.com"]);
  });

  it("records no fetch for the workspace when the stored result is refused", async () => {
    const a = await workspaceOf();

    await expect(inTenant(a, (tx) => faviconRepository(tx).store("Example.COM", ICON))).rejects.toMatchObject({ cause: { code: INVALID_PARAMETER } });

    expect(await fetchesOf(a.id)).toEqual([]);
  });

  it("is replaced by a later fetch, which can record that the host has no icon", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", { status: "none" }));

    expect(await rows()).toMatchObject([{ host: "example.com", status: "none", content: null, content_32: null }]);
    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toEqual({ status: "none" });
  });

  it("is unknown for a host that was never fetched and for one past its expiry by the database clock", async () => {
    const a = await workspaceOf();
    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toBeUndefined();

    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));
    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toBeDefined();
    await asSystem(db, (tx) => tx`UPDATE favicons SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 second'`);

    expect(await inTenant(a, (tx) => faviconRepository(tx).current("example.com", 64))).toBeUndefined();
  });

  it("is refused at any size but 32 and 64", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    for (const size of [0, 16, 48, 128]) {
      await expect(inTenant(a, (tx) => faviconRepository(tx).current("example.com", size as 32))).rejects.toMatchObject({ cause: { code: INVALID_PARAMETER } });
    }
  });
});

describe("the system operation that stores a favicon", () => {
  const BAD: readonly [string, string, string | null, Buffer | null, Buffer | null][] = [
    ["an SVG", "example.com", "ok", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), png(32)],
    ["a 32 px icon that is not a PNG", "example.com", "ok", png(64), Buffer.from("GIF89a-not-a-png")],
    ["an icon of only the signature", "example.com", "ok", PNG_SIGNATURE, png(32)],
    ["a PNG over 64 KiB", "example.com", "ok", png(65_536), png(32)],
    ["an ok row without the 32 px icon", "example.com", "ok", png(64), null],
    ["an ok row without content", "example.com", "ok", null, null],
    ["a none row with content", "example.com", "none", png(64), png(32)],
    ["an unknown status", "example.com", "stale", png(64), png(32)],
    ["no status", "example.com", null, png(64), png(32)],
    ["a host in upper case", "Example.com", "ok", png(64), png(32)],
    ["a host with a path", "example.com/x", "ok", png(64), png(32)],
    ["a host with a port", "example.com:8080", "ok", png(64), png(32)],
    ["a host with an underscore", "ex_ample.com", "ok", png(64), png(32)],
    ["a host with an empty label", "example..com", "ok", png(64), png(32)],
    ["a host with a trailing dot", "example.com.", "ok", png(64), png(32)],
    ["an empty host", "", "ok", png(64), png(32)],
    ["a host over 253 characters", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`, "ok", png(64), png(32)],
  ];

  it.each(BAD)("refuses %s and writes nothing", async (_name, host, status, content, content32) => {
    const a = await workspaceOf();

    await expect(
      inTenant(a, (tx) => faviconRepositoryRaw(tx, host, status, content, content32)),
    ).rejects.toMatchObject({ cause: { code: INVALID_PARAMETER } });

    expect(await rows()).toEqual([]);
  });

  it("keeps the earlier row when a later put is refused", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    await expect(inTenant(a, (tx) => faviconRepositoryRaw(tx, "example.com", "ok", Buffer.from("<svg/>"), png(32)))).rejects.toMatchObject({ cause: { code: INVALID_PARAMETER } });

    expect(await rows()).toMatchObject([{ host: "example.com", status: "ok" }]);
  });

  it("accepts a punycode host and a single-label host", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("xn--bcher-kva.example", ICON));
    await inTenant(a, (tx) => faviconRepository(tx).store("localhost", ICON));

    expect((await rows()).map((row) => row.host)).toEqual(["localhost", "xn--bcher-kva.example"]);
  });
});

/** Calls the put with arguments the repository would not pass, to see what the database itself refuses. */
async function faviconRepositoryRaw(
  tx: Parameters<typeof faviconRepository>[0],
  host: string,
  status: string | null,
  content: Buffer | null,
  content32: Buffer | null,
): Promise<void> {
  await tenantHandle(tx).execute(sql`SELECT sys_favicon_put(${host}::text, ${status}::text, ${content}::bytea, ${content32}::bytea)`);
}

describe("the table", () => {
  it("is out of reach of slugbase_app: it reads, writes and deletes nothing in it directly", async () => {
    await asSystem(db, (tx) => tx`INSERT INTO favicons (host, status, fetched_at, expires_at) VALUES ('example.com', 'none', now(), now() + interval '7 days')`);

    await expect(db.app.unsafe("SELECT * FROM public.favicons")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.app.unsafe("SELECT host FROM public.favicons")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.app.unsafe("INSERT INTO public.favicons (host, status, fetched_at, expires_at) VALUES ('a.example', 'none', now(), now())")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.app.unsafe("UPDATE public.favicons SET status = 'none'")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.app.unsafe("DELETE FROM public.favicons")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
  });

  it("has row-level security enabled and forced and no policy, so even its owner role sees nothing without the system operations", async () => {
    const [flags] = await db.owner<{ enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c WHERE c.oid = 'public.favicons'::regclass`;
    expect(flags).toEqual({ enabled: true, forced: true, policies: 0 });
  });

  it("is reachable by slugbase_app through the two system operations, which are SECURITY DEFINER with a fixed search_path", async () => {
    const functions = await db.owner<{ name: string; definer: boolean; owner: string; config: string[] | null; app: boolean; public_execute: boolean }[]>`
      SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
             has_function_privilege('slugbase_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.proname IN ('sys_favicon_get', 'sys_favicon_put') ORDER BY p.proname`;
    expect(functions).toEqual([
      { name: "sys_favicon_get", definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], app: true, public_execute: false },
      { name: "sys_favicon_put", definer: true, owner: "slugbase_system", config: ["search_path=pg_catalog, public, pg_temp"], app: true, public_execute: false },
    ]);
  });

  it("refuses a row that breaks its checks even when slugbase_system writes it", async () => {
    await expect(asSystem(db, (tx) => tx`INSERT INTO favicons (host, status, content, fetched_at, expires_at) VALUES ('example.com', 'none', ${png(8)}, now(), now())`)).rejects.toMatchObject({ code: "23514" });
    await expect(asSystem(db, (tx) => tx`INSERT INTO favicons (host, status, fetched_at, expires_at, content_type) VALUES ('example.com', 'none', now(), now(), 'image/svg+xml')`)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the table of the fetches of a workspace", () => {
  it("has row-level security enabled and forced with one policy", async () => {
    const [flags] = await db.owner<{ enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c WHERE c.oid = 'public.workspace_favicons'::regclass`;
    expect(flags).toEqual({ enabled: true, forced: true, policies: 1 });
  });

  it("is kept apart by row-level security alone: a read shows nothing of B, a write naming B is refused, and an update touches none of B's rows", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await inTenant(b, (tx) => faviconRepository(tx).store("example.com", ICON));
    const before = await asSystem(db, (tx) => tx`SELECT * FROM workspace_favicons WHERE workspace_id = ${b.id}`);

    expect(await appAs(a, (tx) => tx`SELECT * FROM workspace_favicons`)).toHaveLength(0);
    await expect(
      appAs(a, (tx) => tx`INSERT INTO workspace_favicons (workspace_id, host, fetched_at, expires_at) VALUES (${b.id}, 'planted.example.com', now(), now() + interval '7 days')`),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });
    expect(await appAs(a, (tx) => tx`UPDATE workspace_favicons SET expires_at = now() RETURNING workspace_id`)).toHaveLength(0);
    await expect(
      appAs(
        a,
        (tx) => tx`INSERT INTO workspace_favicons (workspace_id, host, fetched_at, expires_at) VALUES (${b.id}, 'example.com', now(), now()) ON CONFLICT (workspace_id, host) DO UPDATE SET expires_at = now()`,
      ),
    ).rejects.toMatchObject({ code: ROW_LEVEL_SECURITY });

    expect(await asSystem(db, (tx) => tx`SELECT * FROM workspace_favicons WHERE workspace_id = ${b.id}`)).toEqual(before);
  });

  it("lets slugbase_app read, insert and update the dates of a row, and delete or move nothing", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    await expect(appAs(a, (tx) => tx`DELETE FROM workspace_favicons`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(a, (tx) => tx`UPDATE workspace_favicons SET host = 'moved.example.com'`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(appAs(a, (tx) => tx`UPDATE workspace_favicons SET workspace_id = ${freshId()}`)).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    expect(await appAs(a, (tx) => tx`UPDATE workspace_favicons SET fetched_at = now() RETURNING host`)).toHaveLength(1);
  });

  it("refuses a host that is not a lower-case host name, even when slugbase_system writes it", async () => {
    const a = await workspaceOf();

    await expect(asSystem(db, (tx) => tx`INSERT INTO workspace_favicons (workspace_id, host, fetched_at, expires_at) VALUES (${a.id}, 'Example.COM', now(), now())`)).rejects.toMatchObject({ code: "23514" });
  });

  it("is deleted with its workspace", async () => {
    const a = await workspaceOf();
    await inTenant(a, (tx) => faviconRepository(tx).store("example.com", ICON));

    await asSystem(db, (tx) => tx`DELETE FROM workspaces WHERE id = ${a.id}`);

    expect(await fetchesOf(a.id)).toEqual([]);
  });

  it("needs a transaction opened with a workspace to answer or record anything", async () => {
    const a = await workspaceOf();
    const accountOnly = { accountId: a.owner, requestId: "favicons-test" };

    await expect(db.tenant.withTenant(accountOnly, (tx) => faviconRepository(tx).current("example.com", 64))).rejects.toBeInstanceOf(TenantContextError);
    await expect(db.tenant.withTenant(accountOnly, (tx) => faviconRepository(tx).store("example.com", ICON))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the hosts a member may have fetched", () => {
  it("are the hosts of the bookmarks the account can read in the active workspace", async () => {
    const a = await workspaceOf();
    await seedBookmark(a, "own.example.com");

    expect(await inTenant(a, (tx) => faviconRepository(tx).hostReadable("own.example.com"))).toBe(true);
    expect(await inTenant(a, (tx) => faviconRepository(tx).hostReadable("other.example.com"))).toBe(false);
  });

  it("do not include the host of a bookmark in another workspace, even one the account is a member of", async () => {
    const a = await workspaceOf();
    const b = await workspaceOf();
    await seedMember(db, { workspaceId: b.id, accountId: a.owner, role: "member" });
    await seedBookmark(b, "elsewhere.example.com");

    expect(await inTenant(a, (tx) => faviconRepository(tx).hostReadable("elsewhere.example.com"))).toBe(false);
    expect(await inTenant(b, (tx) => faviconRepository(tx).hostReadable("elsewhere.example.com"))).toBe(true);
  });

  it("do not include the host of another member's bookmark in the same workspace, which the account cannot read", async () => {
    const a = await workspaceOf();
    const other = await account();
    await seedMember(db, { workspaceId: a.id, accountId: other, role: "member" });
    await seedBookmark(a, "private.example.com", { ownerId: other });

    expect(await inTenant(a, (tx) => faviconRepository(tx).hostReadable("private.example.com"))).toBe(false);
  });

  it("do not include the host of a plan-archived bookmark", async () => {
    const a = await workspaceOf();
    await seedBookmark(a, "archived.example.com", { archived: true });

    expect(await inTenant(a, (tx) => faviconRepository(tx).hostReadable("archived.example.com"))).toBe(false);
  });

  it("are asked about only in a transaction opened with a workspace", async () => {
    const a = await workspaceOf();

    await expect(db.tenant.withTenant({ accountId: a.owner, requestId: "favicons-test" }, (tx) => faviconRepository(tx).hostReadable("example.com"))).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("the favicon.fetch job", () => {
  it("is queued once for a host while one waits, in the transaction that asks", async () => {
    const a = await workspaceOf();
    const job = (id: string): Parameters<typeof enqueueInTenantTransaction>[1] => ({ id, queue: QUEUE, data: { host: "example.com" }, singletonKey: "example.com" });

    await inTenant(a, async (tx) => {
      await faviconRepository(tx).enqueue(job(freshId()));
      await faviconRepository(tx).enqueue(job(freshId()));
    });
    await inTenant(a, (tx) => faviconRepository(tx).enqueue(job(freshId())));

    const waiting = await db.owner<{ singleton_key: string | null }[]>`SELECT singleton_key FROM pgboss.job`;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.singleton_key).toBe("example.com");
  });
});
