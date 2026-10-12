import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { createDatabase, tenantHandle, type Database } from "../../src/tenant.ts";

// `pnpm perf:go`: the end-of-Phase-1 kill criterion of doc 12 section 5. Can
// forced row-level security through PgBouncer in transaction pooling mode serve
// the `/go` candidate query of doc 05 section 4 at a p95 under 30 ms?
//
// The script builds a scratch database `perf_go_<random>` on the server it is
// pointed at, with synthetic copies of the six tables the query touches (not
// the shipped migrations: the real tables arrive in Phase 3), their documented
// indexes and forced policies of the shape of doc 05 section 3.2, seeded with
// one large workspace and many small ones. It then runs the query through
// `withTenant()` (src/tenant.ts, the production path) in four configurations:
// direct or through PgBouncer, with row-level security on or off. It also
// records EXPLAIN output and the cost of the per-request `set_config` calls.
// It drops the scratch database when it ends (unless --keep), and always drops
// the login role it created, also when it is interrupted (SIGINT, SIGTERM, SIGHUP).
//
// It is an opt-in measurement and never part of `pnpm test:*`. It reports with
// plain stdout writes, like the other scripts of this package, because its
// output is its result. The throwaway rig it expects is
// test/perf/rig/compose.perf.yml; see test/perf/README.md for the run.

const USAGE = `usage: pnpm perf:go [options]
  --pg-url <url>        superuser URL of the Postgres to build the scratch database on
                        (SLUGBASE_PERF_PG_URL; default: the rig of test/perf/rig/compose.perf.yml)
  --pooler <host:port>  PgBouncer in transaction mode in front of that Postgres, which forwards
                        any database name (SLUGBASE_PERF_POOLER; default 127.0.0.1:64330)
  --pooler-admin <p>    password of the PgBouncer admin console user, to record its settings
                        (SLUGBASE_PERF_POOLER_ADMIN_PASSWORD; default: the rig's, used only against the rig)
  --bookmarks <n>       bookmarks of the large workspace (default 50000)
  --workspaces <n>      workspaces in all (default 2000)
  --requests <n>        timed requests per configuration and round at concurrency 1 (default 5000)
  --concurrent <n>      timed requests per configuration and round under load (default 6000)
  --pool-size <n>       client connections of the load phase (default 32)
  --rate <n>            requests per second the load phase offers, open loop (default 300)
  --warmup <n>          untimed requests before each timed phase (default 500)
  --rounds <n>          times the whole matrix runs (default 3)
  --explain-runs <n>    EXPLAIN ANALYZE runs per row-level security setting (default 500)
  --slug-type <t>       column type of the slug in the synthetic tables: citext (doc 05, the default) or text
  --threshold-ms <n>    the p95 budget (default 30)
  --out <file>          also write the results as JSON
  --jit <default|off>   default leaves the server's jit setting; off sets jit = off for the application role,
                        so the plan's JIT compilation time can be told apart from its execution time
  --keep                leave the scratch database in place (the login role is dropped either way)
  --help                print this text

The login role slugbase_perf_app gets the password in SLUGBASE_PERF_APP_PASSWORD. Only against the
rig (loopback, its ports) may the variable be unset; the rig's committed password is used then. Any
other server needs its own password there, and the same password in the PgBouncer's auth file.`;

const DEFAULT_PG_URL = "postgres://slugbase:slugbase@127.0.0.1:54330/slugbase_perf";
const APP_ROLE = "slugbase_perf_app";
/** The password of the rig's role, committed with the rig (rig/userlist.txt). Never used off the rig. */
const RIG_APP_PASSWORD = "slugbase_perf_dev_only";
const MIN_PASSWORD_LENGTH = 16;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const ADMIN_ROLE = "slugbase_perf_admin";
const RIG_ADMIN_PASSWORD = "slugbase_perf_admin_dev_only";
const TENANT_FUNCTIONS = new URL("../../src/sql/020-tenant-context.sql", import.meta.url);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  pgUrl: string;
  poolerHost: string;
  poolerPort: number;
  poolerAdminPassword: string | undefined;
  jit: "default" | "off";
  bookmarks: number;
  workspaces: number;
  requests: number;
  concurrent: number;
  poolSize: number;
  rate: number;
  slugType: "citext" | "text";
  warmup: number;
  rounds: number;
  explainRuns: number;
  thresholdMs: number;
  out: string | undefined;
  keep: boolean;
  help: boolean;
}

function positive(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function slugType(value: string | undefined): "citext" | "text" {
  if (value === undefined || value === "citext") return "citext";
  if (value === "text") return "text";
  throw new Error("--slug-type must be citext or text");
}

function jitSetting(value: string | undefined): "default" | "off" {
  if (value === undefined || value === "default") return "default";
  if (value === "off") return "off";
  throw new Error("--jit must be default or off");
}

function parseOptions(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: argv.filter((argument) => argument !== "--"),
    options: {
      "pg-url": { type: "string" },
      pooler: { type: "string" },
      "pooler-admin": { type: "string" },
      jit: { type: "string" },
      bookmarks: { type: "string" },
      workspaces: { type: "string" },
      requests: { type: "string" },
      concurrent: { type: "string" },
      "pool-size": { type: "string" },
      rate: { type: "string" },
      "slug-type": { type: "string" },
      warmup: { type: "string" },
      rounds: { type: "string" },
      "explain-runs": { type: "string" },
      "threshold-ms": { type: "string" },
      out: { type: "string" },
      keep: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const pooler = values.pooler ?? process.env.SLUGBASE_PERF_POOLER ?? "127.0.0.1:64330";
  const match = /^([^:]+):(\d+)$/.exec(pooler);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error("--pooler must be host:port");
  return {
    pgUrl: values["pg-url"] ?? process.env.SLUGBASE_PERF_PG_URL ?? DEFAULT_PG_URL,
    poolerHost: match[1],
    poolerPort: Number(match[2]),
    poolerAdminPassword: values["pooler-admin"] ?? process.env.SLUGBASE_PERF_POOLER_ADMIN_PASSWORD,
    jit: jitSetting(values.jit),
    bookmarks: positive("bookmarks", values.bookmarks, 50_000),
    workspaces: positive("workspaces", values.workspaces, 2_000),
    requests: positive("requests", values.requests, 5_000),
    concurrent: positive("concurrent", values.concurrent, 6_000),
    poolSize: positive("pool-size", values["pool-size"], 32),
    rate: positive("rate", values.rate, 300),
    slugType: slugType(values["slug-type"]),
    warmup: positive("warmup", values.warmup, 500),
    rounds: positive("rounds", values.rounds, 3),
    explainRuns: positive("explain-runs", values["explain-runs"], 500),
    thresholdMs: positive("threshold-ms", values["threshold-ms"], 30),
    out: values.out,
    keep: values.keep === true,
    help: values.help === true,
  };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function report(line = ""): void {
  process.stdout.write(`${line}\n`);
}

/** A seeded generator, so every run builds the same data and the same requests. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUIDv7 (RFC 9562): identifiers are generated in the application, never by the database. */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? Number.NaN : total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

const ms = (value: number): string => (Number.isNaN(value) ? "n/a" : value.toFixed(2));

function formatSummary(label: string, summary: Summary): string {
  return `${label.padEnd(44)} n=${String(summary.count).padStart(6)}  mean ${ms(summary.mean).padStart(7)}  p50 ${ms(summary.p50).padStart(7)}  p95 ${ms(summary.p95).padStart(7)}  p99 ${ms(summary.p99).padStart(7)}  max ${ms(summary.max).padStart(8)} ms`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Whether the target is the rig of test/perf/rig/compose.perf.yml: loopback and the rig's ports. */
function isRig(options: Options): boolean {
  const server = new URL(options.pgUrl);
  const rigPostgres = Number(process.env.PERF_PG_PORT ?? "54330");
  const rigPooler = Number(process.env.PERF_POOLER_PORT ?? "64330");
  return (
    LOOPBACK_HOSTS.has(server.hostname) &&
    Number(server.port === "" ? "5432" : server.port) === rigPostgres &&
    LOOPBACK_HOSTS.has(options.poolerHost) &&
    options.poolerPort === rigPooler
  );
}

/**
 * The password of the login role the script creates. The committed one is for the
 * rig only: against any other server it comes from the environment, and is never
 * the committed one.
 */
function appPassword(options: Options): string {
  const given = process.env.SLUGBASE_PERF_APP_PASSWORD;
  if (given === undefined || given === "") {
    if (isRig(options)) return RIG_APP_PASSWORD;
    throw new Error(
      "this is not the rig: set SLUGBASE_PERF_APP_PASSWORD to a password of your own (at least 16 characters) for the login role the script creates, and use the same one in the PgBouncer's auth file",
    );
  }
  if (!isRig(options) && (given === RIG_APP_PASSWORD || given.length < MIN_PASSWORD_LENGTH)) {
    throw new Error(
      `SLUGBASE_PERF_APP_PASSWORD must be at least ${String(MIN_PASSWORD_LENGTH)} characters and not the rig's committed password when the target is not the rig`,
    );
  }
  return given;
}

// ---------------------------------------------------------------------------
// The synthetic schema: the six tables of the doc 05 section 4 query, with the
// documented indexes (doc 05 sections 2.3 to 2.6) and the policy shape of
// section 3.2. Only the columns the query and the row width need.
// ---------------------------------------------------------------------------

const TABLES = [
  "bookmarks",
  "bookmark_shares",
  "folder_bookmarks",
  "folder_shares",
  "team_members",
  "slug_preferences",
] as const;

/** The column type of the slug; set once from the options before any SQL is built. */
const settings = { slugType: "citext" as "citext" | "text" };

const schemaSql = (): string => `
CREATE TABLE bookmarks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_id uuid,
  url text NOT NULL,
  url_canonical text NOT NULL,
  host text NOT NULL,
  title text NOT NULL,
  description text,
  slug ${settings.slugType} CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  forwarding boolean NOT NULL DEFAULT false,
  pinned_at timestamptz,
  plan_archived_at timestamptz,
  open_count bigint NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookmarks_workspace_id_id_key UNIQUE (workspace_id, id),
  CONSTRAINT bookmarks_forwarding_needs_slug CHECK (NOT forwarding OR slug IS NOT NULL)
);
CREATE UNIQUE INDEX bookmarks_owner_slug_key ON bookmarks (workspace_id, owner_id, slug) NULLS NOT DISTINCT WHERE slug IS NOT NULL;
CREATE INDEX bookmarks_slug_idx ON bookmarks (workspace_id, slug) INCLUDE (id, owner_id, url, forwarding, plan_archived_at) WHERE slug IS NOT NULL;

CREATE TABLE team_members (
  workspace_id uuid NOT NULL,
  team_id uuid NOT NULL,
  account_id uuid NOT NULL,
  PRIMARY KEY (team_id, account_id)
);
CREATE INDEX team_members_workspace_account_idx ON team_members (workspace_id, account_id);

CREATE TABLE bookmark_shares (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  bookmark_id uuid NOT NULL,
  target_account_id uuid,
  target_team_id uuid,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_account_id IS NULL) <> (target_team_id IS NULL))
);
CREATE UNIQUE INDEX bookmark_shares_account_key ON bookmark_shares (bookmark_id, target_account_id) WHERE target_account_id IS NOT NULL;
CREATE UNIQUE INDEX bookmark_shares_team_key ON bookmark_shares (bookmark_id, target_team_id) WHERE target_team_id IS NOT NULL;
CREATE INDEX bookmark_shares_account_idx ON bookmark_shares (workspace_id, target_account_id, bookmark_id);
CREATE INDEX bookmark_shares_team_idx ON bookmark_shares (workspace_id, target_team_id, bookmark_id);

CREATE TABLE folder_bookmarks (
  workspace_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  bookmark_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (folder_id, bookmark_id)
);
CREATE INDEX folder_bookmarks_workspace_bookmark_idx ON folder_bookmarks (workspace_id, bookmark_id);

CREATE TABLE folder_shares (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  target_account_id uuid,
  target_team_id uuid,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_account_id IS NULL) <> (target_team_id IS NULL))
);
CREATE UNIQUE INDEX folder_shares_account_key ON folder_shares (folder_id, target_account_id) WHERE target_account_id IS NOT NULL;
CREATE UNIQUE INDEX folder_shares_team_key ON folder_shares (folder_id, target_team_id) WHERE target_team_id IS NOT NULL;
CREATE INDEX folder_shares_account_idx ON folder_shares (workspace_id, target_account_id, folder_id);
CREATE INDEX folder_shares_team_idx ON folder_shares (workspace_id, target_team_id, folder_id);

CREATE TABLE slug_preferences (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  slug ${settings.slugType} NOT NULL,
  bookmark_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id, slug)
);
`;

function policySql(): string {
  const statements: string[] = [];
  for (const table of TABLES) {
    const using =
      table === "slug_preferences"
        ? "workspace_id = public.app_workspace_id() AND account_id = public.app_account_id()"
        : "workspace_id = public.app_workspace_id()";
    statements.push(
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY ${table}_tenant ON ${table} USING (${using}) WITH CHECK (${using})`,
      `GRANT SELECT ON ${table} TO ${APP_ROLE}`,
    );
  }
  return statements.join(";\n");
}

async function setRowLevelSecurity(owner: postgres.Sql, enabled: boolean): Promise<void> {
  for (const table of TABLES) {
    await owner.unsafe(
      enabled
        ? `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`
        : `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY; ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
    );
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

interface Hot {
  workspaceId: string;
  members: string[];
  /** Slugs a member owns that no one else carries, per member. */
  ownSlugs: Map<string, string[]>;
  /** Slugs carried by two or more members. */
  collidingSlugs: string[];
  /** Slugs a member can reach only through a share, per member. */
  sharedSlugs: Map<string, string[]>;
}

interface SeedCounts {
  bookmarks: number;
  workspaces: number;
  collidingSlugs: number;
  bookmarkShares: number;
  folders: number;
  folderBookmarks: number;
  folderShares: number;
  teamMembers: number;
  slugPreferences: number;
}

async function insertBatches(
  owner: postgres.Sql,
  table: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<void> {
  const batch = Math.max(1, Math.floor(60_000 / columns.length));
  for (let from = 0; from < rows.length; from += batch) {
    await owner`INSERT INTO ${owner(table)} ${owner(rows.slice(from, from + batch) as never, ...columns)}`;
  }
}

const BOOKMARK_COLUMNS = [
  "id",
  "workspace_id",
  "owner_id",
  "url",
  "url_canonical",
  "host",
  "title",
  "description",
  "slug",
  "forwarding",
  "plan_archived_at",
] as const;

type BookmarkRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  url: string;
  url_canonical: string;
  host: string;
  title: string;
  description: string;
  slug: string | null;
  forwarding: boolean;
  plan_archived_at: Date | null;
};

function bookmarkRow(
  random: () => number,
  workspaceId: string,
  ownerId: string,
  slug: string | null,
  n: number,
): BookmarkRow {
  return {
    id: uuidv7(),
    workspace_id: workspaceId,
    owner_id: ownerId,
    url: `https://example.org/articles/${String(n)}/some-reasonably-long-path-segment`,
    url_canonical: `https://example.org/articles/${String(n)}/some-reasonably-long-path-segment`,
    host: "example.org",
    title: `Bookmark ${String(n)}: a title of ordinary length for a saved page`,
    description: `A description of about the length a fetched meta description has, for bookmark ${String(n)}.`,
    slug,
    forwarding: slug !== null && random() < 0.9,
    plan_archived_at: slug !== null && random() < 0.01 ? new Date() : null,
  };
}

async function seed(owner: postgres.Sql, options: Options): Promise<{ hot: Hot; counts: SeedCounts }> {
  const random = mulberry32(34);
  const hotWorkspace = uuidv7();
  const members = Array.from({ length: 50 }, () => uuidv7());
  const teams = Array.from({ length: 10 }, () => uuidv7());

  const bookmarks: BookmarkRow[] = [];
  const ownSlugs = new Map<string, string[]>(members.map((member) => [member, []]));
  const collidingSlugs: string[] = [];

  // Colliding slugs: 100 slugs, each carried by 2 to 50 distinct members (at
  // most one bookmark per member, as the owner-slug unique index requires). A
  // smaller workspace gets fewer groups, and never more rows than it holds.
  const collidingGroups = Math.min(100, Math.floor(options.bookmarks / 20));
  for (let group = 0; group < collidingGroups; group += 1) {
    const carriers = 2 + (group % 49);
    if (bookmarks.length + carriers > options.bookmarks) break;
    const slug = `shared-${String(group)}`;
    collidingSlugs.push(slug);
    for (let index = 0; index < carriers; index += 1) {
      const member = members[(group * 7 + index) % members.length];
      if (member === undefined) throw new Error("member index out of range");
      bookmarks.push(bookmarkRow(random, hotWorkspace, member, slug, bookmarks.length));
    }
  }
  // The rest: a unique slug for nine in ten, none for the others.
  for (let index = bookmarks.length; index < options.bookmarks; index += 1) {
    const member = members[index % members.length];
    if (member === undefined) throw new Error("member index out of range");
    const slug = index % 10 === 0 ? null : `u-${String(index)}`;
    const row = bookmarkRow(random, hotWorkspace, member, slug, index);
    bookmarks.push(row);
    if (slug !== null && row.forwarding && row.plan_archived_at === null) ownSlugs.get(member)?.push(slug);
  }
  const largeWorkspaceBookmarks = bookmarks.length;
  await insertBatches(owner, "bookmarks", BOOKMARK_COLUMNS, bookmarks);

  const teamMembers: Record<string, unknown>[] = [];
  for (const team of teams) {
    const chosen = new Set<string>();
    while (chosen.size < 8) chosen.add(pick(members, random));
    for (const account of chosen) {
      teamMembers.push({ workspace_id: hotWorkspace, team_id: team, account_id: account });
    }
  }

  // Shares: a bookmark with a slug, to a member other than its owner or to a team.
  const slugged = bookmarks.filter((row) => row.slug !== null);
  const sharedSlugs = new Map<string, string[]>(members.map((member) => [member, []]));
  const bookmarkShares: Record<string, unknown>[] = [];
  const sharedKeys = new Set<string>();
  const shareTarget = Math.min(5_000, Math.floor(slugged.length / 2));
  while (bookmarkShares.length < shareTarget) {
    const target = pick(slugged, random);
    const toTeam = random() < 0.4;
    const recipient = toTeam ? pick(teams, random) : pick(members, random);
    const key = `${target.id}:${recipient}`;
    if (sharedKeys.has(key) || (!toTeam && recipient === target.owner_id)) continue;
    sharedKeys.add(key);
    bookmarkShares.push({
      id: uuidv7(),
      workspace_id: hotWorkspace,
      bookmark_id: target.id,
      target_account_id: toTeam ? null : recipient,
      target_team_id: toTeam ? recipient : null,
      granted_by: target.owner_id,
    });
    if (!toTeam && target.slug !== null && !target.slug.startsWith("shared-") && target.forwarding && target.plan_archived_at === null) {
      sharedSlugs.get(recipient)?.push(target.slug);
    }
  }

  // Folders: 500, each holding 20 of their owner's bookmarks, 1 000 folder shares.
  const folders = Array.from({ length: 500 }, () => ({ id: uuidv7(), owner: pick(members, random) }));
  const folderBookmarks: Record<string, unknown>[] = [];
  const filed = new Set<string>();
  for (const folder of folders) {
    for (let index = 0; index < 20; index += 1) {
      const target = pick(slugged, random);
      const key = `${folder.id}:${target.id}`;
      if (filed.has(key)) continue;
      filed.add(key);
      folderBookmarks.push({ workspace_id: hotWorkspace, folder_id: folder.id, bookmark_id: target.id });
    }
  }
  const folderShares: Record<string, unknown>[] = [];
  const folderShareKeys = new Set<string>();
  const folderShareTarget = Math.min(1_000, folders.length * 2);
  while (folderShares.length < folderShareTarget) {
    const folder = pick(folders, random);
    const toTeam = random() < 0.4;
    const recipient = toTeam ? pick(teams, random) : pick(members, random);
    const key = `${folder.id}:${recipient}`;
    if (folderShareKeys.has(key) || (!toTeam && recipient === folder.owner)) continue;
    folderShareKeys.add(key);
    folderShares.push({
      id: uuidv7(),
      workspace_id: hotWorkspace,
      folder_id: folder.id,
      target_account_id: toTeam ? null : recipient,
      target_team_id: toTeam ? recipient : null,
      granted_by: folder.owner,
    });
  }

  // Slug preferences: a member's choice among the bookmarks carrying a colliding slug.
  const slugPreferences: Record<string, unknown>[] = [];
  const preferenceKeys = new Set<string>();
  const preferenceTarget = Math.min(300, collidingSlugs.length * 3);
  while (slugPreferences.length < preferenceTarget && collidingSlugs.length > 0) {
    const account = pick(members, random);
    const slug = pick(collidingSlugs, random);
    const key = `${account}:${slug}`;
    const target = bookmarks.find((row) => row.slug === slug);
    if (preferenceKeys.has(key) || target === undefined) continue;
    preferenceKeys.add(key);
    slugPreferences.push({ workspace_id: hotWorkspace, account_id: account, slug, bookmark_id: target.id });
  }

  // The other workspaces: small, each with three members, one team, a few shares.
  const small = options.workspaces - 1;
  const perWorkspace = Math.max(1, Math.floor(options.bookmarks / 2_500));
  let smallBookmarks = 0;
  for (let index = 0; index < small; index += 1) {
    const workspaceId = uuidv7();
    const smallMembers = [uuidv7(), uuidv7(), uuidv7()];
    const team = uuidv7();
    const rows: BookmarkRow[] = [];
    for (let at = 0; at < perWorkspace; at += 1) {
      const member = smallMembers[at % smallMembers.length];
      if (member === undefined) throw new Error("member index out of range");
      rows.push(bookmarkRow(random, workspaceId, member, `w-${String(at)}`, smallBookmarks + at));
    }
    smallBookmarks += rows.length;
    bookmarks.push(...rows);
    for (const member of smallMembers) {
      teamMembers.push({ workspace_id: workspaceId, team_id: team, account_id: member });
    }
    const first = rows[0];
    if (first !== undefined) {
      bookmarkShares.push({
        id: uuidv7(),
        workspace_id: workspaceId,
        bookmark_id: first.id,
        target_account_id: null,
        target_team_id: team,
        granted_by: first.owner_id,
      });
    }
  }
  // The small workspaces' bookmarks were not inserted with the large one's.
  await insertBatches(owner, "bookmarks", BOOKMARK_COLUMNS, bookmarks.slice(largeWorkspaceBookmarks));

  await insertBatches(owner, "team_members", ["workspace_id", "team_id", "account_id"], teamMembers);
  await insertBatches(
    owner,
    "bookmark_shares",
    ["id", "workspace_id", "bookmark_id", "target_account_id", "target_team_id", "granted_by"],
    bookmarkShares,
  );
  await insertBatches(owner, "folder_bookmarks", ["workspace_id", "folder_id", "bookmark_id"], folderBookmarks);
  await insertBatches(
    owner,
    "folder_shares",
    ["id", "workspace_id", "folder_id", "target_account_id", "target_team_id", "granted_by"],
    folderShares,
  );
  await insertBatches(
    owner,
    "slug_preferences",
    ["workspace_id", "account_id", "slug", "bookmark_id"],
    slugPreferences,
  );

  return {
    hot: { workspaceId: hotWorkspace, members, ownSlugs, collidingSlugs, sharedSlugs },
    counts: {
      bookmarks: bookmarks.length,
      workspaces: options.workspaces,
      collidingSlugs: collidingSlugs.length,
      bookmarkShares: bookmarkShares.length,
      folders: folders.length,
      folderBookmarks: folderBookmarks.length,
      folderShares: folderShares.length,
      teamMembers: teamMembers.length,
      slugPreferences: slugPreferences.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The query: doc 05 section 4, verbatim, with $W, $A and $slug as parameters.
// ---------------------------------------------------------------------------

function goQuery(workspaceId: string, accountId: string, slug: string) {
  const w = sql`${workspaceId}::uuid`;
  const a = sql`${accountId}::uuid`;
  const s = sql`${slug}::${sql.raw(settings.slugType)}`;
  return sql`WITH candidates AS (
  SELECT id, owner_id, url
  FROM bookmarks
  WHERE workspace_id = ${w} AND slug = ${s} AND forwarding AND plan_archived_at IS NULL
), my_teams AS (
  SELECT team_id FROM team_members WHERE workspace_id = ${w} AND account_id = ${a}
)
SELECT c.id, c.url, c.owner_id,
       (SELECT bookmark_id FROM slug_preferences
         WHERE workspace_id = ${w} AND account_id = ${a} AND slug = ${s}) AS preferred_id
FROM candidates c
WHERE c.owner_id = ${a}
   OR EXISTS (SELECT 1 FROM bookmark_shares s WHERE s.workspace_id = ${w} AND s.bookmark_id = c.id
                AND (s.target_account_id = ${a} OR s.target_team_id IN (SELECT team_id FROM my_teams)))
   OR EXISTS (SELECT 1 FROM folder_bookmarks fb JOIN folder_shares fs
                ON fs.workspace_id = fb.workspace_id AND fs.folder_id = fb.folder_id
              WHERE fb.workspace_id = ${w} AND fb.bookmark_id = c.id
                AND (fs.target_account_id = ${a} OR fs.target_team_id IN (SELECT team_id FROM my_teams)))`;
}

type RequestKind = "own" | "shared" | "colliding" | "miss";

interface GoRequest {
  kind: RequestKind;
  accountId: string;
  slug: string;
}

/** Forty in a hundred requests hit the member's own slug, twenty a shared one, twenty-five a colliding one, fifteen miss. */
function makeRequests(hot: Hot, count: number, seed: number): GoRequest[] {
  const random = mulberry32(seed);
  const requests: GoRequest[] = [];
  while (requests.length < count) {
    const accountId = pick(hot.members, random);
    const roll = random();
    if (roll < 0.4) {
      const slug = hot.ownSlugs.get(accountId);
      if (slug !== undefined && slug.length > 0) requests.push({ kind: "own", accountId, slug: pick(slug, random) });
    } else if (roll < 0.6) {
      const slug = hot.sharedSlugs.get(accountId);
      if (slug !== undefined && slug.length > 0) requests.push({ kind: "shared", accountId, slug: pick(slug, random) });
    } else if (roll < 0.85) {
      requests.push({ kind: "colliding", accountId, slug: pick(hot.collidingSlugs, random) });
    } else {
      requests.push({ kind: "miss", accountId, slug: `missing-${String(Math.floor(random() * 1e6))}` });
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// Running requests
// ---------------------------------------------------------------------------

interface Timed {
  total: number;
  /** BEGIN, the set_config statement and the wait for a connection: from the call to `fn` starting. */
  setup: number;
  /** The candidate query alone, as the client sees it. */
  query: number;
  /** COMMIT. */
  commit: number;
  rows: number;
}

/**
 * One request. `due` is when an open-loop request was scheduled: the time from
 * then on counts, so a backlog in the client or the pool shows in the latency.
 */
async function runRequest(database: Database, hot: Hot, request: GoRequest, due?: number): Promise<Timed> {
  const started = due ?? performance.now();
  let entered = started;
  let queried = started;
  let rows = 0;
  await database.withTenant(
    { accountId: request.accountId, workspaceId: hot.workspaceId, requestId: "perf-go" },
    async (tx) => {
      entered = performance.now();
      const result = await tenantHandle(tx).execute(goQuery(hot.workspaceId, request.accountId, request.slug));
      rows = Array.from(result).length;
      queried = performance.now();
    },
  );
  const finished = performance.now();
  return {
    total: finished - started,
    setup: entered - started,
    query: queried - entered,
    commit: finished - queried,
    rows,
  };
}

interface PhaseResult {
  total: Summary;
  setup: Summary;
  query: Summary;
  commit: Summary;
  meanRows: number;
  rowsByKind: Record<RequestKind, number>;
  wallSeconds: number;
  requestsPerSecond: number;
}

async function runPhase(
  database: Database,
  hot: Hot,
  requests: readonly GoRequest[],
  load: { clients: 1 } | { rate: number },
): Promise<PhaseResult> {
  const timings: Timed[] = new Array<Timed>(requests.length);
  const started = performance.now();
  if ("clients" in load) {
    // Closed loop: one request after the other.
    for (const [index, request] of requests.entries()) {
      timings[index] = await runRequest(database, hot, request);
    }
  } else {
    // Open loop: requests arrive at a fixed rate whatever the answers' pace.
    const interval = 1000 / load.rate;
    const inflight: Promise<void>[] = [];
    for (const [index, request] of requests.entries()) {
      const due = started + index * interval;
      const wait = due - performance.now();
      if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
      inflight.push(
        runRequest(database, hot, request, due).then((timing) => {
          timings[index] = timing;
        }),
      );
    }
    await Promise.all(inflight);
  }
  const wallSeconds = (performance.now() - started) / 1000;
  const rowsByKind: Record<RequestKind, number> = { own: 0, shared: 0, colliding: 0, miss: 0 };
  const countByKind: Record<RequestKind, number> = { own: 0, shared: 0, colliding: 0, miss: 0 };
  timings.forEach((timing, index) => {
    const kind = requests[index]?.kind;
    if (kind === undefined) return;
    rowsByKind[kind] += timing.rows;
    countByKind[kind] += 1;
  });
  for (const kind of Object.keys(rowsByKind) as RequestKind[]) {
    rowsByKind[kind] = countByKind[kind] === 0 ? 0 : rowsByKind[kind] / countByKind[kind];
  }
  return {
    total: summarize(timings.map((timing) => timing.total)),
    setup: summarize(timings.map((timing) => timing.setup)),
    query: summarize(timings.map((timing) => timing.query)),
    commit: summarize(timings.map((timing) => timing.commit)),
    meanRows: timings.reduce((sum, timing) => sum + timing.rows, 0) / timings.length,
    rowsByKind,
    wallSeconds,
    requestsPerSecond: timings.length / wallSeconds,
  };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

interface Configuration {
  name: string;
  via: "direct" | "pooled";
  rls: boolean;
}

const CONFIGURATIONS: readonly Configuration[] = [
  { name: "pooled, RLS on (the criterion)", via: "pooled", rls: true },
  { name: "direct, RLS on", via: "direct", rls: true },
  { name: "pooled, RLS off", via: "pooled", rls: false },
  { name: "direct, RLS off", via: "direct", rls: false },
];

interface ConfigurationSamples {
  sequential: PhaseResult[];
  loaded: PhaseResult[];
}

/** Pools the per-round timings of a configuration into one summary per metric. */
function pooled(results: readonly PhaseResult[], metric: "total" | "setup" | "query" | "commit"): Summary {
  // Percentiles of percentiles are not percentiles: the raw samples are not kept
  // across rounds, so the rounds are summarized by their median and their worst.
  const p95s = results.map((result) => result[metric].p95);
  const p50s = results.map((result) => result[metric].p50);
  const p99s = results.map((result) => result[metric].p99);
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
  };
  return {
    count: results.reduce((sum, result) => sum + result[metric].count, 0),
    mean: results.reduce((sum, result) => sum + result[metric].mean, 0) / results.length,
    p50: median(p50s),
    p95: median(p95s),
    p99: median(p99s),
    max: Math.max(...results.map((result) => result[metric].max)),
  };
}

function appUrl(host: string, port: number, database: string, password: string): string {
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `postgres://${APP_ROLE}:${encodeURIComponent(password)}@${hostPart}:${String(port)}/${database}`;
}

// ---------------------------------------------------------------------------
// EXPLAIN and the cost of set_config
// ---------------------------------------------------------------------------

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  Filter?: string;
  "Heap Fetches"?: number;
  "Rows Removed by Filter"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Total Cost"?: number;
  Plans?: PlanNode[];
}

interface ExplainDocument {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
  /** Present only when the executor compiled the plan with JIT; "Execution Time" includes it. */
  JIT?: { Functions?: number; Timing?: { Total?: number } };
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

interface PlanFacts {
  candidateScan: string;
  candidateIndexOnly: boolean;
  candidateIndexCond: string | undefined;
  candidateFilter: string | undefined;
  /** Whether the slug is part of the index condition, not a filter applied to the rows the index returns. */
  slugInIndexCond: boolean;
  rowsRemovedByFilter: number | undefined;
  heapFetches: number | undefined;
  sequentialScans: string[];
  scans: string[];
  planningMs: number;
  /** Includes the JIT compilation time. */
  executionMs: number;
  /** JIT compilation time inside the execution time; 0 when the plan was not compiled. */
  jitMs: number;
  /** The plan's estimated total cost: JIT is considered above jit_above_cost. */
  estimatedCost: number | undefined;
}

function jitMs(document: ExplainDocument): number {
  return document.JIT?.Timing?.Total ?? 0;
}

function planFacts(document: ExplainDocument): PlanFacts {
  const scans: string[] = [];
  const sequentialScans: string[] = [];
  let candidate: PlanNode | undefined;
  walk(document.Plan, (node) => {
    if (node["Relation Name"] === undefined) return;
    const label = `${node["Node Type"]} on ${node["Relation Name"]}${node["Index Name"] === undefined ? "" : ` using ${node["Index Name"]}`}`;
    scans.push(label);
    if (node["Node Type"] === "Seq Scan") sequentialScans.push(node["Relation Name"]);
    if (node["Relation Name"] === "bookmarks" && candidate === undefined) candidate = node;
  });
  return {
    candidateScan:
      candidate === undefined
        ? "none found"
        : `${candidate["Node Type"]} on ${candidate["Relation Name"] ?? "?"}${candidate["Index Name"] === undefined ? "" : ` using ${candidate["Index Name"]}`}`,
    candidateIndexOnly: candidate?.["Node Type"] === "Index Only Scan" && candidate["Index Name"] === "bookmarks_slug_idx",
    candidateIndexCond: candidate?.["Index Cond"],
    candidateFilter: candidate?.Filter,
    slugInIndexCond: /\bslug\b/.test(candidate?.["Index Cond"] ?? ""),
    rowsRemovedByFilter: candidate?.["Rows Removed by Filter"],
    heapFetches: candidate?.["Heap Fetches"],
    sequentialScans,
    scans,
    planningMs: document["Planning Time"],
    executionMs: document["Execution Time"],
    jitMs: jitMs(document),
    estimatedCost: document.Plan["Total Cost"],
  };
}

async function explain(database: Database, hot: Hot, request: GoRequest, analyze: boolean): Promise<ExplainDocument> {
  return database.withTenant(
    { accountId: request.accountId, workspaceId: hot.workspaceId, requestId: "perf-explain" },
    async (tx) => {
      const options = analyze ? "ANALYZE, BUFFERS, FORMAT JSON" : "FORMAT JSON";
      const result = await tenantHandle(tx).execute<{ "QUERY PLAN": ExplainDocument[] }>(
        sql`EXPLAIN (${sql.raw(options)}) ${goQuery(hot.workspaceId, request.accountId, request.slug)}`,
      );
      const document = Array.from(result)[0]?.["QUERY PLAN"][0];
      if (document === undefined) throw new Error("EXPLAIN returned no plan");
      return document;
    },
  );
}

interface ExplainResult {
  byKind: Partial<Record<RequestKind, { facts: PlanFacts; json: ExplainDocument }>>;
  planning: Summary;
  /** Includes the JIT compilation time. */
  execution: Summary;
  /** JIT compilation time per run, 0 for a run whose plan was not compiled. */
  jit: Summary;
  /** Execution time without the JIT compilation time. */
  executionWithoutJit: Summary;
  /** Runs whose plan was compiled with JIT. */
  jitRuns: number;
}

async function explainPhase(
  database: Database,
  hot: Hot,
  requests: readonly GoRequest[],
  runs: number,
): Promise<ExplainResult> {
  const byKind: ExplainResult["byKind"] = {};
  for (const kind of ["own", "shared", "colliding", "miss"] as const) {
    const request = requests.find((candidate) => candidate.kind === kind);
    if (request === undefined) continue;
    const json = await explain(database, hot, request, true);
    byKind[kind] = { facts: planFacts(json), json };
  }
  const planning: number[] = [];
  const execution: number[] = [];
  const jit: number[] = [];
  const withoutJit: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const request = requests[index % requests.length];
    if (request === undefined) break;
    const document = await explain(database, hot, request, true);
    planning.push(document["Planning Time"]);
    execution.push(document["Execution Time"]);
    jit.push(jitMs(document));
    withoutJit.push(document["Execution Time"] - jitMs(document));
  }
  return {
    byKind,
    planning: summarize(planning),
    execution: summarize(execution),
    jit: summarize(jit),
    executionWithoutJit: summarize(withoutJit),
    jitRuns: jit.filter((value) => value > 0).length,
  };
}

interface SetConfigCost {
  /** BEGIN and COMMIT with no statement between them. */
  emptyTransaction: Summary;
  setConfigStatement: Summary;
  transactionWithSetConfig: Summary;
}

/**
 * The separate cost of the three `set_config` calls: a transaction with no
 * statement (BEGIN and COMMIT only), the one statement `withTenant` runs first
 * (timed on its own inside an open transaction), and the two together.
 */
async function setConfigCost(url: string, hot: Hot, runs: number): Promise<SetConfigCost> {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  const accountId = hot.members[0] ?? "";
  const empty: number[] = [];
  const statement: number[] = [];
  const both: number[] = [];
  try {
    for (let index = 0; index < runs + 100; index += 1) {
      const measured = index >= 100;
      let started = performance.now();
      await client.begin(() => undefined);
      if (measured) empty.push(performance.now() - started);
      started = performance.now();
      await client.begin(async (tx) => {
        const inner = performance.now();
        await tx`SELECT set_config('app.account_id', ${accountId}, true),
                        set_config('app.workspace_id', ${hot.workspaceId}, true),
                        set_config('app.request_id', 'perf-go', true)`;
        if (measured) statement.push(performance.now() - inner);
      });
      if (measured) both.push(performance.now() - started);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
  return {
    emptyTransaction: summarize(empty),
    setConfigStatement: summarize(statement),
    transactionWithSetConfig: summarize(both),
  };
}

// ---------------------------------------------------------------------------
// The rig, as the scripts can see it
// ---------------------------------------------------------------------------

async function describeRig(
  owner: postgres.Sql,
  options: Options,
  rigTarget: boolean,
  appJit: string,
): Promise<Record<string, string>> {
  const facts: Record<string, string> = {};
  const settings = await owner<{ name: string; setting: string; unit: string | null }[]>`
    SELECT name, setting, unit FROM pg_settings
    WHERE name IN ('shared_buffers', 'effective_cache_size', 'work_mem', 'max_connections', 'random_page_cost',
                   'jit', 'plan_cache_mode', 'server_version', 'max_parallel_workers_per_gather')`;
  for (const row of settings) facts[row.name] = row.unit === null ? row.setting : `${row.setting} ${row.unit}`;
  facts["jit (application role)"] = appJit;
  facts.version = (await owner<{ version: string }[]>`SELECT version()`)[0]?.version ?? "unknown";
  const adminPassword = options.poolerAdminPassword ?? (rigTarget ? RIG_ADMIN_PASSWORD : undefined);
  if (adminPassword === undefined) {
    facts["pgbouncer.admin"] = "console not read: no admin password given (SLUGBASE_PERF_POOLER_ADMIN_PASSWORD)";
    return facts;
  }
  const admin = postgres({
    host: options.poolerHost,
    port: options.poolerPort,
    database: "pgbouncer",
    username: ADMIN_ROLE,
    password: adminPassword,
    max: 1,
    fetch_types: false,
    onnotice: () => undefined,
  });
  try {
    const config = await admin.unsafe<{ key: string; value: string }[]>("SHOW CONFIG");
    for (const row of config) {
      if (["pool_mode", "default_pool_size", "max_client_conn", "max_prepared_statements", "auth_type"].includes(row.key)) {
        facts[`pgbouncer.${row.key}`] = row.value;
      }
    }
    const versionRow = (await admin.unsafe<{ version: string }[]>("SHOW VERSION"))[0];
    facts["pgbouncer.version"] = versionRow?.version ?? "unknown";
  } catch (error) {
    facts["pgbouncer.admin"] = `console not readable: ${error instanceof Error ? error.message : "unknown error"}`;
  } finally {
    await admin.end({ timeout: 5 });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Results {
  rig: Record<string, string>;
  seed: SeedCounts;
  options: Record<string, unknown>;
  matrix: Record<string, { sequential: PhaseResult[]; loaded: PhaseResult[] }>;
  explain: Record<string, ExplainResult>;
  setConfig: Record<string, SetConfigCost>;
  rlsEffective: { rlsOn: number; rlsOff: number };
  verdict: { criterionP95Ms: { sequential: number; loaded: number }; thresholdMs: number; sequentialWithinBudget: boolean; loadedWithinBudget: boolean };
}

/** What the script has created on the target server, so that it can be removed on every way out. */
interface Created {
  admin: postgres.Sql;
  databaseName: string;
  databaseCreated: boolean;
  roleCreated: boolean;
  owner: postgres.Sql | undefined;
}

let cleanup: Promise<void> | undefined;

/**
 * Removes the login role in every case, and the scratch database unless `keep`.
 * Runs once: a second call (a signal during the normal exit) waits for the first.
 * A step that fails is reported with the statement to run by hand, so a role with
 * a password never stays behind unannounced.
 */
function removeCreated(created: Created, keep: boolean, patient: boolean): Promise<void> {
  cleanup ??= (async () => {
    const failed = (what: string, statement: string, error: unknown): void => {
      process.stderr.write(
        `perf:go: could not ${what}: ${error instanceof Error ? error.message : String(error)}\n  run by hand: ${statement}\n`,
      );
    };
    const owner = created.owner;
    if (owner !== undefined && created.roleCreated && keep) {
      // The kept database must not hold a privilege of the role, or the role cannot be dropped.
      try {
        await owner.unsafe(`DROP OWNED BY ${APP_ROLE}`);
      } catch (error) {
        failed("revoke the role's privileges in the kept database", `DROP OWNED BY ${APP_ROLE}`, error);
      }
    }
    // After a signal the measurement is still running on its own connections:
    // dropping the database with FORCE ends them, and ending them first would race it.
    if (owner !== undefined && patient) await owner.end({ timeout: 5 }).catch(() => undefined);
    if (created.databaseCreated && !keep) {
      try {
        await created.admin.unsafe(`DROP DATABASE IF EXISTS ${created.databaseName} WITH (FORCE)`);
      } catch (error) {
        failed("drop the scratch database", `DROP DATABASE IF EXISTS ${created.databaseName} WITH (FORCE)`, error);
      }
    }
    if (created.roleCreated) {
      try {
        await created.admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`);
      } catch (error) {
        failed("drop the login role", `DROP ROLE IF EXISTS ${APP_ROLE}`, error);
      }
    }
    if (patient) await created.admin.end({ timeout: 5 }).catch(() => undefined);
  })();
  return cleanup;
}

async function main(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    report(USAGE);
    return 0;
  }
  settings.slugType = options.slugType;
  const rigTarget = isRig(options);
  const password = appPassword(options);
  const created: Created = {
    admin: postgres(options.pgUrl, { max: 1, onnotice: () => undefined }),
    databaseName: `perf_go_${randomBytes(6).toString("hex")}`,
    databaseCreated: false,
    roleCreated: false,
    owner: undefined,
  };
  const { admin, databaseName } = created;
  // Node's default exit on a signal skips `finally`, so the role is dropped here.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      process.stderr.write(`perf:go: ${signal}, removing the scratch database and the login role\n`);
      // The measurement's own connections fail once the database is dropped under them; the process is ending.
      process.on("uncaughtException", () => undefined);
      process.on("unhandledRejection", () => undefined);
      void removeCreated(created, false, false).finally(() => process.exit(code));
    });
  }

  try {
    if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`).length > 0) {
      throw new Error(
        `the role ${APP_ROLE} already exists on this server (a run that was killed may have left it); drop it first: DROP OWNED BY ${APP_ROLE}; DROP ROLE ${APP_ROLE}`,
      );
    }
    created.roleCreated = true;
    await admin.unsafe(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${password.replaceAll("'", "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    if (options.jit === "off") await admin.unsafe(`ALTER ROLE ${APP_ROLE} SET jit = off`);
    created.databaseCreated = true;
    await admin.unsafe(`CREATE DATABASE ${databaseName}`);
    const owner = postgres(withDatabase(options.pgUrl, databaseName), { max: 2, onnotice: () => undefined });
    created.owner = owner;

    await owner.unsafe("CREATE EXTENSION IF NOT EXISTS citext");
    await owner.unsafe(readFileSync(TENANT_FUNCTIONS, "utf8"));
    await owner.unsafe(schemaSql());
    await owner.unsafe(policySql());
    report(`scratch database ${databaseName}: seeding ${String(options.bookmarks)} bookmarks in one workspace, ${String(options.workspaces)} workspaces`);
    const seeded = await seed(owner, options);
    await owner.unsafe("VACUUM (ANALYZE)");
    report(`seeded: ${JSON.stringify(seeded.counts)}`);

    const directUrl = (() => {
      const parsed = new URL(options.pgUrl);
      return appUrl(parsed.hostname, Number(parsed.port === "" ? "5432" : parsed.port), databaseName, password);
    })();
    const pooledUrl = appUrl(options.poolerHost, options.poolerPort, databaseName, password);
    const appSession = postgres(directUrl, { max: 1, onnotice: () => undefined });
    const appJit = await appSession<{ jit: string }[]>`SHOW jit`.then((rows) => rows[0]?.jit ?? "unknown").finally(() =>
      appSession.end({ timeout: 5 }),
    );
    const rig = await describeRig(owner, options, rigTarget, appJit);

    const sequentialRequests = makeRequests(seeded.hot, options.requests, 1);
    const loadedRequests = makeRequests(seeded.hot, options.concurrent, 2);
    const warmupRequests = makeRequests(seeded.hot, options.warmup, 3);

    const samples = new Map<string, ConfigurationSamples>(
      CONFIGURATIONS.map((configuration) => [configuration.name, { sequential: [], loaded: [] }]),
    );
    for (let round = 1; round <= options.rounds; round += 1) {
      for (const rls of [true, false]) {
        await setRowLevelSecurity(owner, rls);
        for (const configuration of CONFIGURATIONS.filter((candidate) => candidate.rls === rls)) {
          const url = configuration.via === "pooled" ? pooledUrl : directUrl;
          const entry = samples.get(configuration.name);
          if (entry === undefined) continue;
          const single = createDatabase({ url, poolSize: 1 });
          try {
            await runPhase(single, seeded.hot, warmupRequests, { clients: 1 });
            entry.sequential.push(await runPhase(single, seeded.hot, sequentialRequests, { clients: 1 }));
          } finally {
            await single.close();
          }
          const loaded = createDatabase({ url, poolSize: options.poolSize });
          try {
            await runPhase(loaded, seeded.hot, warmupRequests, { rate: options.rate });
            entry.loaded.push(await runPhase(loaded, seeded.hot, loadedRequests, { rate: options.rate }));
          } finally {
            await loaded.close();
          }
          const last = entry.sequential[entry.sequential.length - 1];
          const lastLoaded = entry.loaded[entry.loaded.length - 1];
          report(
            `round ${String(round)} ${configuration.name}: concurrency 1 p95 ${ms(last?.total.p95 ?? Number.NaN)} ms; at ${String(options.rate)}/s p95 ${ms(lastLoaded?.total.p95 ?? Number.NaN)} ms, ${String(Math.round(lastLoaded?.requestsPerSecond ?? 0))} requests/s`,
          );
        }
      }
    }

    // Row-level security really applies to the role and the pool measured: a
    // request that names the large workspace but runs for another one sees
    // nothing with the policies on and everything with them off.
    const probe = seeded.hot.collidingSlugs[0] ?? "";
    const foreign = createDatabase({ url: directUrl, poolSize: 1 });
    const rlsEffective = { rlsOn: -1, rlsOff: -1 };
    try {
      for (const rls of [true, false]) {
        await setRowLevelSecurity(owner, rls);
        const count = await foreign.withTenant(
          { accountId: seeded.hot.members[0] ?? "", workspaceId: uuidv7(), requestId: "perf-rls-probe" },
          async (tx) => {
            const rows = await tenantHandle(tx).execute(
              sql`SELECT count(*)::int AS n FROM bookmarks WHERE workspace_id = ${seeded.hot.workspaceId}::uuid AND slug = ${probe}::${sql.raw(settings.slugType)}`,
            );
            return (Array.from(rows)[0] as { n: number } | undefined)?.n ?? -1;
          },
        );
        if (rls) rlsEffective.rlsOn = count;
        else rlsEffective.rlsOff = count;
      }
    } finally {
      await foreign.close();
    }

    const explainResults: Record<string, ExplainResult> = {};
    const setConfig: Record<string, SetConfigCost> = {};
    for (const rls of [true, false]) {
      await setRowLevelSecurity(owner, rls);
      const label = rls ? "RLS on" : "RLS off";
      const direct = createDatabase({ url: directUrl, poolSize: 1 });
      try {
        explainResults[label] = await explainPhase(direct, seeded.hot, sequentialRequests, options.explainRuns);
      } finally {
        await direct.close();
      }
      setConfig[`direct, ${label}`] = await setConfigCost(directUrl, seeded.hot, options.requests);
      setConfig[`pooled, ${label}`] = await setConfigCost(pooledUrl, seeded.hot, options.requests);
    }

    // The criterion: pooled, RLS on.
    const matrix: Results["matrix"] = {};
    for (const [name, entry] of samples) matrix[name] = entry;
    const criterion = samples.get("pooled, RLS on (the criterion)");
    const sequentialP95 = criterion === undefined ? Number.NaN : pooled(criterion.sequential, "total").p95;
    const loadedP95 = criterion === undefined ? Number.NaN : pooled(criterion.loaded, "total").p95;

    report();
    report("=== rig ===");
    for (const [key, value] of Object.entries(rig)) report(`${key}: ${value}`);
    report(`rows per request kind (mean, pooled RLS on, concurrency 1): ${JSON.stringify(criterion?.sequential[0]?.rowsByKind ?? {})}`);
    report(`rls probe (rows seen for another workspace's slug): policies on ${String(rlsEffective.rlsOn)}, off ${String(rlsEffective.rlsOff)}`);

    for (const phase of ["sequential", "loaded"] as const) {
      report();
      report(
        phase === "sequential"
          ? `=== client-observed request time, concurrency 1, ${String(options.requests)} requests x ${String(options.rounds)} rounds (median of the rounds' percentiles) ===`
          : `=== client-observed request time, offered load of ${String(options.rate)} requests/s over ${String(options.poolSize)} client connections, ${String(options.concurrent)} requests x ${String(options.rounds)} rounds (median of the rounds' percentiles) ===`,
      );
      for (const configuration of CONFIGURATIONS) {
        const entry = samples.get(configuration.name);
        if (entry === undefined) continue;
        const results = entry[phase];
        report(formatSummary(`${configuration.name} total (BEGIN..COMMIT)`, pooled(results, "total")));
        report(formatSummary("    BEGIN + set_config", pooled(results, "setup")));
        report(formatSummary("    candidate query", pooled(results, "query")));
        report(formatSummary("    COMMIT", pooled(results, "commit")));
        report(`    per-round total p95: ${results.map((result) => ms(result.total.p95)).join(", ")} ms; ${String(Math.round(results.reduce((sum, result) => sum + result.requestsPerSecond, 0) / results.length))} requests/s`);
      }
    }

    report();
    report("=== server time: EXPLAIN (ANALYZE) of the candidate query, direct, inside withTenant ===");
    for (const [label, result] of Object.entries(explainResults)) {
      report(formatSummary(`${label} planning`, result.planning));
      report(formatSummary(`${label} execution (includes JIT)`, result.execution));
      report(formatSummary(`${label}   of which JIT compilation`, result.jit));
      report(formatSummary(`${label}   execution without JIT`, result.executionWithoutJit));
      report(`${label}: ${String(result.jitRuns)} of ${String(result.execution.count)} runs were compiled with JIT (jit for the application role: ${rig["jit (application role)"] ?? "unknown"})`);
      for (const [kind, entry] of Object.entries(result.byKind)) {
        report(
          `  ${label} / ${kind}: candidate scan ${entry.facts.candidateScan}; index only ${String(entry.facts.candidateIndexOnly)}; slug in index condition ${String(entry.facts.slugInIndexCond)}; rows removed by filter ${String(entry.facts.rowsRemovedByFilter ?? 0)}; heap fetches ${String(entry.facts.heapFetches)}; sequential scans [${entry.facts.sequentialScans.join(", ")}]; planning ${ms(entry.facts.planningMs)} ms, execution ${ms(entry.facts.executionMs)} ms of which JIT ${ms(entry.facts.jitMs)} ms; estimated cost ${String(entry.facts.estimatedCost ?? "n/a")}`,
        );
        report(`    index cond: ${entry.facts.candidateIndexCond ?? "none"}; filter: ${entry.facts.candidateFilter ?? "none"}`);
        report(`    scans: ${entry.facts.scans.join(" | ")}`);
      }
    }

    report();
    report("=== the set_config calls (one connection, sequential) ===");
    for (const [label, cost] of Object.entries(setConfig)) {
      report(formatSummary(`${label}: BEGIN + COMMIT, no statement`, cost.emptyTransaction));
      report(formatSummary(`${label}: the set_config statement`, cost.setConfigStatement));
      report(formatSummary(`${label}: BEGIN + set_config + COMMIT`, cost.transactionWithSetConfig));
    }

    const verdict: Results["verdict"] = {
      criterionP95Ms: { sequential: sequentialP95, loaded: loadedP95 },
      thresholdMs: options.thresholdMs,
      sequentialWithinBudget: sequentialP95 < options.thresholdMs,
      loadedWithinBudget: loadedP95 < options.thresholdMs,
    };
    report();
    report("=== verdict ===");
    report(
      `pooled, RLS on, p95 ${ms(sequentialP95)} ms at concurrency 1 and ${ms(loadedP95)} ms at an offered ${String(options.rate)} requests/s, against ${String(options.thresholdMs)} ms`,
    );
    report(
      verdict.sequentialWithinBudget && verdict.loadedWithinBudget
        ? "within the budget on this instance (a result for this hardware only; re-run on a production-sized instance before deciding)"
        : "over the budget on this instance: name the cause from the EXPLAIN and phase output above",
    );

    if (options.out !== undefined) {
      // The URL and the console password of the instance are not written out.
      const publicOptions = Object.fromEntries(
        Object.entries(options).filter(([key]) => key !== "pgUrl" && key !== "poolerAdminPassword"),
      );
      const results: Results = {
        rig,
        seed: seeded.counts,
        options: publicOptions,
        matrix,
        explain: explainResults,
        setConfig,
        rlsEffective,
        verdict,
      };
      writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`);
      report(`results written to ${options.out}`);
    }
    return 0;
  } finally {
    await removeCreated(created, options.keep, true);
    if (options.keep) {
      report(`kept scratch database ${databaseName}; the login role ${APP_ROLE} is dropped, inspect it as the superuser`);
    }
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`perf:go: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
  process.exitCode = 1;
}
