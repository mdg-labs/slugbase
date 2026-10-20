import { randomBytes } from "node:crypto";
import { hashCredentialToken } from "@slugbase/core";
import type { TestDatabase } from "@slugbase/testing/db";
import { expect } from "vitest";
import type { EntitlementCheck } from "../../src/http/authorize.ts";
import { send, type Person, type World, type WorkspaceHarness } from "../workspaces/support.ts";

// The requests and the rows the invitation suites of the token flows share (the enumeration and rate-limit suites of
// doc 08 section 3.5 and the invitation token suite): an admin who invites, the link that returns the token where no
// mail is sent, and the three requests the invited person redeems it with.

export const INVITATIONS = "/api/v1/invitations";
export const INSPECT = `${INVITATIONS}/inspect`;
export const ACCEPT = `${INVITATIONS}/accept`;
export const FORGOT = "/api/v1/auth/password/forgot";
export const SIGNUP_PASSWORD = "correct horse battery staple 42";

/** The composition holds `members.invite`, which the operations of an admin declare. */
export const GRANTED: EntitlementCheck = (entitlement) => entitlement === "members.invite";

export interface Issued {
  readonly id: string;
  readonly token: string;
}

/** A token nobody issued, in the shape of one. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A workspace with an owner and an admin, who sends the invitations. */
export async function workspaceWithAdmin(harness: WorkspaceHarness, world: World) {
  const owner = await harness.person(world);
  const admin = await harness.person(world);
  const { workspaceId } = await harness.workspaceOf([
    { person: owner, role: "owner" },
    { person: admin, role: "admin" },
  ]);
  return { workspaceId, owner, admin };
}

/** Invites `email` and returns the invitation's identifier. */
export async function createInvitation(world: World, admin: Person, email: string, role: "admin" | "member" = "member", headers: Record<string, string> = {}): Promise<string> {
  const created = await send(world, "POST", INVITATIONS, { cookie: admin.cookie, ...headers }, { email, role });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** Asks for the link of the invitation, which is where a deployment without mail gets the token, and returns its token. */
export async function linkOf(world: World, admin: Person, id: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await send(world, "POST", `${INVITATIONS}/${id}/link`, { cookie: admin.cookie, ...headers });
  expect(response.status).toBe(200);
  const { link } = (await response.json()) as { link: string };
  const token = new URL(link).pathname.split("/").at(-1);
  if (token === undefined || hashCredentialToken(token) === undefined) {
    throw new Error("the link carries no token");
  }
  return token;
}

/** Invites `email` and links the invitation. */
export async function invite(world: World, admin: Person, email: string, role: "admin" | "member" = "member"): Promise<Issued> {
  const id = await createInvitation(world, admin, email, role);
  return { id, token: await linkOf(world, admin, id) };
}

export const resend = (world: World, admin: Person, id: string, headers: Record<string, string> = {}): Promise<Response> =>
  send(world, "POST", `${INVITATIONS}/${id}/resend`, { cookie: admin.cookie, ...headers });

export const revoke = (world: World, admin: Person, id: string): Promise<Response> => send(world, "DELETE", `${INVITATIONS}/${id}`, { cookie: admin.cookie });

/** The inspection, anonymous. */
export const inspect = (world: World, token: string, headers: Record<string, string> = {}): Promise<Response> => send(world, "POST", INSPECT, headers, { token });

/** The acceptance with the token alone, as the signed-in account. */
export const acceptAs = (world: World, person: Person, token: string, headers: Record<string, string> = {}): Promise<Response> =>
  send(world, "POST", ACCEPT, { cookie: person.cookie, ...headers }, { token });

/** The acceptance with a display name and a password, which creates the account of the invited address. */
export const signup = (world: World, token: string, fields: Record<string, unknown> = { displayName: "Grace Hopper", password: SIGNUP_PASSWORD }, headers: Record<string, string> = {}): Promise<Response> =>
  send(world, "POST", ACCEPT, headers, { token, ...fields });

export interface InvitationRow {
  readonly status: string;
  readonly accepted_by: string | null;
  readonly role: string;
  readonly token_hash: Buffer;
  readonly seconds_to_expiry: number;
}

/** The invitation's row as the system role reads it; `seconds_to_expiry` is by the database clock, which also judges the expiry. */
export async function invitationRow(database: TestDatabase, id: string): Promise<InvitationRow> {
  const rows = await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    return tx<InvitationRow[]>`
      SELECT status, accepted_by, role::text AS role, token_hash, extract(epoch FROM (expires_at - clock_timestamp()))::float8 AS seconds_to_expiry
      FROM workspace_invitations WHERE id = ${id}`;
  });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no such invitation");
  }
  return row;
}

/** Moves the expiry of the invitation to `seconds` from the database's now, as slugbase_system, which the application role may not do. */
export async function setExpiry(database: TestDatabase, id: string, seconds: number): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspace_invitations SET expires_at = clock_timestamp() + ${seconds} * interval '1 second' WHERE id = ${id}`;
  });
}

/** The queued jobs the invitation flows write. */
export async function queuedJobCount(database: TestDatabase, name: string): Promise<number> {
  const rows = await database.app<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job WHERE name = ${name}`;
  return rows[0]?.count ?? -1;
}

/** Marks a workspace as being deleted, as slugbase_system. */
export async function markDeleting(database: TestDatabase, workspaceId: string): Promise<void> {
  await database.owner.begin(async (tx) => {
    await tx`SET LOCAL ROLE slugbase_system`;
    await tx`UPDATE workspaces SET deleting_at = now() WHERE id = ${workspaceId}`;
  });
}

let addressNumber = 0;

/** An address nobody holds. */
export function freshAddress(prefix = "invitee"): string {
  addressNumber += 1;
  return `${prefix}.${String(addressNumber)}@example.test`;
}
