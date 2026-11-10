import { randomBytes } from "node:crypto";
import { expect } from "@playwright/test";
import { enrolSecondFactor } from "./instance-admin.ts";
import { codeAfter, Session, type DrillStack } from "./restore-drill.ts";
import { totpStep } from "./totp.ts";

// The instance the drills seed through the HTTP API and read back (doc 08 section 5.1): the owner of a workspace made by the
// setup, folders, tags, bookmarks with slugs, a member who accepted an invitation and turned on an authenticator app, and a
// share of one bookmark with that member. The backup and restore drill (e2e/restore-drill.spec.ts) and the upgrade drill
// (e2e/upgrade-drill.spec.ts) both seed it here, and read it back with the same snapshot, so what one proves about an
// instance is what the other proves. Its passwords, keys and codes are made up for the run and are never printed.

export const BOOKMARKS = 8;
export const SLUGGED = 4;
export const FOLDERS = ["Reading", "Tools"];
export const TAGS = ["alpha", "beta", "gamma"];
/** The bookmark the owner shares with the member. */
export const SHARED = 1;

export interface BookmarkView {
  id: string;
  url: string;
  title: string;
  slug: string | null;
  forwarding: boolean;
  pinned: boolean;
  tags: string[];
  folders: string[];
}

export interface Snapshot {
  bookmarks: BookmarkView[];
  folders: { name: string; bookmarkCount: number }[];
  tags: { name: string; bookmarkCount: number }[];
}

export interface Account {
  email: string;
  password: string;
}

export interface Seeded {
  owner: Account;
  member: Account & { id: string; key: string; lastStep: number };
  snapshot: Snapshot;
  sharedId: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value;
}

export function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${what} is not a text`);
  }
  return value;
}

export function list(value: unknown, what: string): unknown[] {
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

export async function bookmarksOf(session: Session, scope: "mine" | "shared_with_me"): Promise<BookmarkView[]> {
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

export async function snapshotOf(session: Session): Promise<Snapshot> {
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

/** The number of shares of a bookmark, which only its owner reads. */
export async function shareCountOf(session: Session, bookmarkId: string): Promise<number> {
  const body = record(await session.read(`/api/v1/bookmarks/${bookmarkId}/shares`), "the shares of a bookmark");
  return list(body.items, "the shares of a bookmark").length;
}

export function newSession(stack: DrillStack): Session {
  return new Session(stack.baseUrl, stack.appOrigin);
}

export async function signIn(stack: DrillStack, account: Account): Promise<Session> {
  const session = newSession(stack);
  const answer = record(await session.expect("POST", "/api/v1/auth/login", 200, { email: account.email, password: account.password }), "the sign-in");
  expect(answer.next, "a sign-in with the password alone").toBe("done");
  return session;
}

/** Signs in with the password and the code of the authenticator app; the session is the member's, whole. */
export async function signInWithCode(stack: DrillStack, seeded: Seeded): Promise<Session> {
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

/** Makes the instance on a stack that has just started and returns what was made and a snapshot of what the owner sees. */
export async function seedInstance(stack: DrillStack): Promise<Seeded> {
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
  return { owner, member: { ...member, id: memberId, key, lastStep: totpStep(Date.now()) }, snapshot: await snapshotOf(ownerSession), sharedId, token };
}
