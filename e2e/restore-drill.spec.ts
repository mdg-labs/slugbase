import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { enrolSecondFactor } from "./support/instance-admin.ts";
import {
  codeAfter,
  compose,
  DRILL_SETUP_MS,
  dumpDatabase,
  envFileWithKey,
  readyOf,
  Session,
  shippedMigrations,
  startDrillStack,
  tableCount,
  waitForDatabase,
  waitForReady,
  type DrillStack,
} from "./support/restore-drill.ts";
import { totpStep } from "./support/totp.ts";

// The backup and restore drill (doc 08 section 5.1, doc 02 section 13.4, Q56, D25): it proves
// docs/self-hosting/backup-restore.md on the built image. It makes an instance with bookmarks, folders, tags,
// slugs, a member with a second factor and a share, takes the dump the guide takes, destroys the database,
// restores the dump the way the guide says and starts the image, which migrates before it serves. It then checks
// that the data is back, /go/<slug> forwards, the member signs in with a code, and /ready reports the level of
// migrations the checkout ships. A second variant restores the same dump under another ENCRYPTION_KEY, as an
// operator who lost the key would: everything is back except the second factor, which cannot be opened, and
// putting the key back repairs it, as the guide's troubleshooting says.
//
// The stack is the drill's own (e2e/restore-drill-stack.sh): it destroys its database, so it never shares one with
// the journeys. Its passwords, keys and codes are made up for the run and are never printed.

const BOOKMARKS = 8;
const SLUGGED = 4;
const FOLDERS = ["Reading", "Tools"];
const TAGS = ["alpha", "beta", "gamma"];
/** The bookmark the owner shares with the member. */
const SHARED = 1;

interface BookmarkView {
  id: string;
  url: string;
  title: string;
  slug: string | null;
  forwarding: boolean;
  pinned: boolean;
  tags: string[];
  folders: string[];
}

interface Snapshot {
  bookmarks: BookmarkView[];
  folders: { name: string; bookmarkCount: number }[];
  tags: { name: string; bookmarkCount: number }[];
}

interface Account {
  email: string;
  password: string;
}

interface Seeded {
  owner: Account;
  member: Account & { id: string; key: string; lastStep: number };
  snapshot: Snapshot;
  sharedId: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${what} is not a text`);
  }
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${what} is not a list`);
  }
  return value as unknown[];
}

function names(value: unknown, what: string): string[] {
  return list(value, what)
    .map((entry) => text(record(entry, what).name, `a name in ${what}`))
    .sort();
}

/** The one page of a list: the drill holds far fewer than a page, so a cursor is an error. */
async function page(session: Session, path: string): Promise<Record<string, unknown>[]> {
  const body = record(await session.read(path), path);
  if (body.nextCursor !== null) {
    throw new Error(`${path} has more than one page`);
  }
  return list(body.items, `the items of ${path}`).map((item) => record(item, `an item of ${path}`));
}

async function bookmarksOf(session: Session, scope: "mine" | "shared_with_me"): Promise<BookmarkView[]> {
  const items = await page(session, `/api/v1/bookmarks?scope=${scope}&limit=100`);
  return items
    .map((item) => ({
      id: text(item.id, "a bookmark id"),
      url: text(item.url, "a bookmark address"),
      title: text(item.title, "a bookmark title"),
      slug: item.slug === null ? null : text(item.slug, "a slug"),
      forwarding: item.forwarding === true,
      pinned: item.pinned === true,
      tags: names(item.tags, "the tags of a bookmark"),
      folders: names(item.folders, "the folders of a bookmark"),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

async function snapshotOf(session: Session): Promise<Snapshot> {
  const counted = (items: Record<string, unknown>[], what: string): { name: string; bookmarkCount: number }[] =>
    items
      .map((item) => {
        const count = item.bookmarkCount;
        if (typeof count !== "number") {
          throw new Error(`${what} has no bookmark count`);
        }
        return { name: text(item.name, `the name of ${what}`), bookmarkCount: count };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    bookmarks: await bookmarksOf(session, "mine"),
    folders: counted(await page(session, "/api/v1/folders?scope=mine&limit=100"), "a folder"),
    tags: counted(await page(session, "/api/v1/tags?limit=100"), "a tag"),
  };
}

function newSession(stack: DrillStack): Session {
  return new Session(stack.baseUrl, stack.appOrigin);
}

async function signIn(stack: DrillStack, account: Account): Promise<Session> {
  const session = newSession(stack);
  const answer = record(await session.expect("POST", "/api/v1/auth/login", 200, { email: account.email, password: account.password }), "the sign-in");
  expect(answer.next, "a sign-in with the password alone").toBe("done");
  return session;
}

/** Signs in with the password and the code of the authenticator app; the session is the member's, whole. */
async function signInWithCode(stack: DrillStack, seeded: Seeded): Promise<Session> {
  const { member } = seeded;
  const session = newSession(stack);
  const first = record(await session.expect("POST", "/api/v1/auth/login", 200, { email: member.email, password: member.password }), "the sign-in");
  expect(first.next, "the sign-in of a member with a second factor asks for it").toBe("mfa");
  const { code, step } = await codeAfter(member.key, member.lastStep);
  member.lastStep = step;
  const second = record(await session.expect("POST", "/api/v1/auth/mfa/verify", 200, { code }), "the second step");
  expect(second.next, "the second step").toBe("done");
  const me = record(await session.read("/api/v1/me"), "the account");
  expect(record(me.account, "the account").id, "the account that signed in").toBe(member.id);
  return session;
}

async function seed(stack: DrillStack): Promise<Seeded> {
  const token = randomBytes(4).toString("hex");
  const origin = stack.appOrigin;
  const owner = { email: `owner-${token}@example.test`, password: randomBytes(24).toString("base64url") };
  const ownerSession = newSession(stack);
  await ownerSession.expect("POST", "/api/v1/setup", 201, {
    displayName: "Drill Owner",
    email: owner.email,
    password: owner.password,
    workspaceName: "Drill",
    setupToken: stack.setupToken,
  });

  const folderIds: string[] = [];
  for (const name of FOLDERS) {
    folderIds.push(text(record(await ownerSession.expect("POST", "/api/v1/folders", 201, { name }), "a folder").id, "a folder id"));
  }
  const ids: string[] = [];
  for (let index = 0; index < BOOKMARKS; index += 1) {
    const slugged = index < SLUGGED;
    const created = record(
      await ownerSession.expect("POST", "/api/v1/bookmarks", 201, {
        url: `https://drill.example.test/page/${String(index)}`,
        title: `Drill page ${String(index)}`,
        description: `Page ${String(index)} of the drill`,
        pinned: index === 0,
        tagNames: TAGS.filter((_, tag) => tag <= index % TAGS.length),
        folderIds: [folderIds[index % folderIds.length] ?? ""],
        ...(slugged ? { slug: `drill-${token}-${String(index)}` } : {}),
      }),
      "a bookmark",
    );
    ids.push(text(created.id, "a bookmark id"));
  }

  const invitation = record(await ownerSession.expect("POST", "/api/v1/invitations", 201, { email: `member-${token}@example.test`, role: "member" }), "the invitation");
  const link = record(await ownerSession.expect("POST", `/api/v1/invitations/${text(invitation.id, "an invitation id")}/link`, 200), "the invitation link");
  const inviteToken = new URL(text(link.link, "the invitation link")).pathname.slice("/invite/".length);
  const member = { email: `member-${token}@example.test`, password: randomBytes(24).toString("base64url") };
  const memberSession = newSession(stack);
  await memberSession.expect("POST", "/api/v1/invitations/accept", 201, { token: inviteToken, displayName: "Drill Member", password: member.password });
  const memberId = text(record(record(await memberSession.read("/api/v1/me"), "the account").account, "the account").id, "the member's account id");

  const sharedId = ids[SHARED] ?? "";
  await ownerSession.expect("POST", `/api/v1/bookmarks/${sharedId}/shares`, 201, { accountId: memberId });
  const key = await enrolSecondFactor(memberSession, member.password, origin);
  const seeded: Seeded = { owner, member: { ...member, id: memberId, key, lastStep: totpStep(Date.now()) }, snapshot: await snapshotOf(ownerSession), sharedId, token };

  // Before the dump the instance already does what it must do after the restore.
  await checkInstance(stack, seeded, "works");
  return seeded;
}

/** The data, the forwarding, the share and the second factor of the instance, as seeded. */
async function checkInstance(stack: DrillStack, seeded: Seeded, secondFactor: "works" | "fails"): Promise<void> {
  const owner = await signIn(stack, seeded.owner);
  const { snapshot } = seeded;

  await test.step("the bookmarks, folders and tags are all there", async () => {
    const now = await snapshotOf(owner);
    expect(now.bookmarks.length, "the number of bookmarks").toBe(BOOKMARKS);
    expect(now.folders.length, "the number of folders").toBe(FOLDERS.length);
    expect(now.tags.length, "the number of tags").toBe(TAGS.length);
    expect(now, "every bookmark, folder and tag as it was").toEqual(snapshot);
  });

  await test.step("/go/<slug> forwards to the bookmark", async () => {
    const slugged = snapshot.bookmarks.filter((bookmark) => bookmark.slug !== null);
    expect(slugged.length, "the bookmarks with a slug").toBe(SLUGGED);
    for (const bookmark of slugged) {
      const reply = await owner.get(`/go/${bookmark.slug ?? ""}`);
      expect(reply.status(), `GET /go/${bookmark.slug ?? ""}`).toBe(302);
      expect(reply.headers.get("location"), `where /go/${bookmark.slug ?? ""} forwards`).toBe(bookmark.url);
    }
  });

  await test.step("the member's second factor and share", async () => {
    if (secondFactor === "works") {
      const member = await signInWithCode(stack, seeded);
      const shared = await bookmarksOf(member, "shared_with_me");
      expect(shared.map((bookmark) => bookmark.id), "the bookmarks shared with the member").toEqual([seeded.sharedId]);
      return;
    }
    // The password is right, so the first step answers; the second step cannot open the secret that was sealed under the lost key.
    const member = newSession(stack);
    const first = record(await member.expect("POST", "/api/v1/auth/login", 200, { email: seeded.member.email, password: seeded.member.password }), "the sign-in");
    expect(first.next, "the sign-in of the member asks for the second factor").toBe("mfa");
    const { code, step } = await codeAfter(seeded.member.key, seeded.member.lastStep);
    seeded.member.lastStep = step;
    const second = await member.mutate("POST", "/api/v1/auth/mfa/verify", { code });
    expect(second.status(), "the second step under another ENCRYPTION_KEY").toBeGreaterThanOrEqual(400);
    expect((await member.get("/api/v1/me")).status(), "the account after the refused second step").toBe(401);
    expect((await member.get("/api/v1/bookmarks")).status(), "the bookmarks after the refused second step").toBe(401);
  });

  await test.step("/ready reports the level of migrations of the checkout", async () => {
    const ready = await readyOf(stack.baseUrl);
    expect(ready.status, "GET /ready").toBe(200);
    expect(ready.database, "the database in /ready").toBe("ok");
    expect(ready.expected, "the expected migrations in /ready").toBe(shippedMigrations());
    expect(ready.applied, "the applied migrations in /ready").toBe(shippedMigrations());
  });
}

const PSQL = ["exec", "-T", "postgres", "psql", "-U", "slugbase", "--no-psqlrc", "-v", "ON_ERROR_STOP=1"];

test.describe("the backup and restore drill", () => {
  let stack: DrillStack | undefined;
  let seeded: Seeded | undefined;
  let dump = "";
  let healthy = true;

  test.beforeAll(async () => {
    test.setTimeout(DRILL_SETUP_MS);
    try {
      stack = await startDrillStack();
      seeded = await seed(stack);
      dump = join(stack.workDir, "backups", "slugbase.dump");
      await test.step("the dump of the guide is made and lists its contents", () => {
        dumpDatabase(stack as DrillStack, dump);
        const listing = compose(stack as DrillStack, ["exec", "-T", "postgres", "pg_restore", "--list"], { stdinFile: dump }).stdout;
        expect(listing, "the contents of the dump").toContain("TABLE DATA public bookmarks");
      });
    } catch (error) {
      healthy = false;
      await stack?.finish(false);
      throw error;
    }
  });

  test.afterEach(({}, info) => {
    if (info.status !== info.expectedStatus) {
      healthy = false;
    }
  });

  test.afterAll(async () => {
    await stack?.finish(healthy);
  });

  function started(): { stack: DrillStack; seeded: Seeded } {
    if (stack === undefined || seeded === undefined) {
      throw new Error("the stack of the drill did not start");
    }
    return { stack, seeded };
  }

  test("restores the dump into a recreated database with the key it was made under", async () => {
    const { stack: drill, seeded: instance } = started();

    await test.step("the application is stopped and the database is recreated with its roles", () => {
      compose(drill, ["stop", "slugbase", "slugbase-worker"]);
      compose(drill, [...PSQL, "-d", "postgres", "-c", "DROP DATABASE slugbase WITH (FORCE)", "-c", "CREATE DATABASE slugbase"]);
      compose(drill, [...PSQL, "-d", "slugbase", "-q", "-f", "/docker-entrypoint-initdb.d/10-roles.sql"]);
      expect(tableCount(drill), "the tables of the recreated database").toBe(0);
    });

    await test.step("the dump is restored in one transaction", () => {
      compose(drill, ["exec", "-T", "postgres", "pg_restore", "-U", "slugbase", "-d", "slugbase", "--exit-on-error", "--single-transaction"], { stdinFile: dump });
      expect(tableCount(drill), "the tables after the restore").toBeGreaterThan(0);
    });

    await test.step("the application starts and migrates", async () => {
      compose(drill, ["up", "-d"]);
      await waitForReady(drill.baseUrl);
    });

    await checkInstance(drill, instance, "works");
  });

  test("restores the dump under another ENCRYPTION_KEY: the data is back and the second factor is not", async () => {
    const { stack: drill, seeded: instance } = started();
    const wrongKey = randomBytes(32).toString("base64");
    const wrongEnv = envFileWithKey(drill, wrongKey, "wrong-key.env");

    await test.step("the old installation is gone and a new one has an empty database with the roles", () => {
      compose(drill, ["down", "--volumes", "--remove-orphans"]);
      compose(drill, ["up", "-d", "postgres"], { envFile: wrongEnv });
      waitForDatabase(drill);
      expect(tableCount(drill), "the tables of the new database").toBe(0);
    });

    await test.step("the dump is restored", () => {
      compose(drill, ["exec", "-T", "postgres", "pg_restore", "-U", "slugbase", "-d", "slugbase", "--exit-on-error", "--single-transaction"], { stdinFile: dump });
    });

    await test.step("the application starts with the other key", async () => {
      compose(drill, ["up", "-d"], { envFile: wrongEnv });
      await waitForReady(drill.baseUrl);
    });

    await checkInstance(drill, instance, "fails");

    await test.step("the key is put back, and the member signs in", async () => {
      compose(drill, ["up", "-d"]);
      await waitForReady(drill.baseUrl);
      const member = await signInWithCode(drill, instance);
      expect((await member.get("/api/v1/me")).status(), "the account with the key put back").toBe(200);
    });
  });
});
