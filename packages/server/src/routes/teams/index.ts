import {
  createTeam as createTeamOperation,
  deleteTeam as deleteTeamOperation,
  getTeam as getTeamOperation,
  listTeams as listTeamsOperation,
  replaceTeamMembers as replaceTeamMembersOperation,
  updateTeam as updateTeamOperation,
  type TeamSchema,
  type TeamWithMembersSchema,
} from "@slugbase/contracts";
import { createAuditWriter, createTeam, deleteTeam, listTeams, readTeam, replaceTeamMembers, updateTeam, type AuditActor, type TeamDetail, type TeamInvalid, type TeamRecord } from "@slugbase/core";
import { accountProfileRepository, auditEventRepository, isTeamNameTaken, teamRepository } from "@slugbase/db";
import type { z } from "zod";
import { createPageCursorCodec } from "../../auth/page-cursor.ts";
import { uuidv7 } from "../../auth/uuidv7.ts";
import type { ChainContext, RouteBinding } from "../../http/chain.ts";
import { ProblemError } from "../../http/problem.ts";
import type { RequestTenant } from "../../http/tenant.ts";
import { networkPrefixOf } from "../../http/trusted-proxy.ts";
import { route } from "../register.ts";
import { acceptedVersions, entityTagOf } from "../workspaces/if-match.ts";

// GET, POST /api/v1/teams, GET, PATCH, DELETE /api/v1/teams/{id} and PUT /api/v1/teams/{id}/members (doc 04 section 10.5, doc 02 section 4, doc 05
// section 2.3, doc 10 T1, T2 and T11). All act in the workspace the request is bound to and name none.
//
// A team is the workspace's and no member's. The two reads are a member's (a session, or a token with the read scope): every member lists the
// teams and reads a team with its members, which the share picker needs. The four changes are an admin's or an owner's, declare no token scope
// and carry the `teams.manage` entitlement, so stage 9 of the chain refuses a plain member, a token and a workspace without the entitlement
// before a handler runs. A team of another workspace and one that does not exist are the same `404 not_found`, since the statements of the
// repository name the workspace and the policies of the tables keep to it. A name is 1 to 64 characters after the whitespace around it is
// removed, stored as entered and unique in the workspace without regard to case: creating or renaming to a name another team has is `409
// name_taken` and writes nothing. A description is 0 to 280 characters.
//
// GET /api/v1/teams lists the teams in pages of at most 100 that the `nextCursor` resumes (doc 04 section 6.1): the cursor is the name and the
// identifier of the last team, signed with a subkey derived from the session secret for this list over the workspace it was issued for, and a
// forged, altered or foreign cursor is `400 bad_request`. GET, POST, PATCH and PUT answer the team's version as `ETag`. PATCH is a JSON Merge
// Patch of the name and the description; `If-Match` is compared with the version under the team's row lock and a mismatch is `412
// precondition_failed` with nothing written; without the header the patch applies. A patch that changes nothing answers 200 with the unchanged
// `ETag`. PUT replaces the member set: every account must be a current member of the workspace (anything else is `422 validation_failed` with
// nothing written), and the version does not move since it covers the name and the description. DELETE removes the team and its memberships; the
// repeat is `404`.
//
// Each change and its audit event (`team.created`, `team.updated`, `team.deleted`, `team.members_changed`, which name the team and nothing about
// its members) are one transaction, so the event exists exactly when the change does.

const UNAUTHENTICATED = "Authentication is required.";
const NO_WORKSPACE = "No such resource.";
const NO_SUCH_TEAM = "No such resource.";
const NAME_TAKEN = "The workspace already has a team with this name.";
const NAME_INVALID = "A team name has 1 to 64 characters.";
const DESCRIPTION_INVALID = "A team description has at most 280 characters.";
const STALE_VERSION = "The team has changed since it was read; read it again and retry.";
const BAD_CURSOR = "The cursor is not valid.";
const NOT_MEMBERS = "Every account must be a current member of the workspace.";
const FIELD_CODES = { empty: "too_small", too_long: "too_big" } as const;

export interface TeamRoutesOptions {
  /** The server secret the list cursors are signed with, through a key derived for this list alone. */
  readonly cursorSecret: string;
}

/** The workspace the request acts in; the authorization stage has already answered 404 for a request that acts in none. */
function tenantOf(context: ChainContext): RequestTenant {
  const tenant = context.get("tenant");
  if (tenant === undefined) {
    throw new ProblemError("not_found", NO_WORKSPACE);
  }
  return tenant;
}

/** A statement that met another team's name at the key of the table ended its transaction with nothing written; that is the answer `name_taken`. */
function nameTakenWhen(error: unknown): { readonly kind: "name_taken" } {
  if (isTeamNameTaken(error)) {
    return { kind: "name_taken" };
  }
  throw error;
}

function invalidField(invalid: TeamInvalid): ProblemError {
  return new ProblemError("validation_failed", invalid.field === "name" ? NAME_INVALID : DESCRIPTION_INVALID, {
    errors: [{ path: invalid.field, code: FIELD_CODES[invalid.reason] }],
  });
}

function nameTaken(): ProblemError {
  return new ProblemError("name_taken", NAME_TAKEN, { errors: [{ path: "name", code: "name_taken" }] });
}

function summaryBody(team: TeamRecord): z.input<typeof TeamSchema> {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    memberCount: team.memberCount,
    version: team.version,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
  };
}

function teamBody(team: TeamDetail): z.input<typeof TeamWithMembersSchema> {
  return { ...summaryBody(team), members: team.members.map(({ accountId, displayName, email }) => ({ accountId, displayName, email })) };
}

function withEntityTag(team: TeamDetail) {
  return { body: teamBody(team), headers: { ETag: entityTagOf(team.version) } };
}

interface Acting {
  readonly workspaceId: string;
  readonly actor: AuditActor;
  readonly ipPrefix: string | null;
}

export function teamRoutes({ cursorSecret }: TeamRoutesOptions): RouteBinding[] {
  const codec = createPageCursorCodec(cursorSecret, "teams");

  /**
   * Runs `work` in the request's transaction with the stores of the teams and the audit log bound to it and the actor of the audit event: the
   * session's account under its display name at the time. An account whose profile cannot be read is no member of the workspace any more, so the
   * team is a resource it cannot see.
   */
  async function acting<T>(context: ChainContext, work: (stores: { readonly store: ReturnType<typeof teamRepository>; readonly audit: ReturnType<typeof createAuditWriter> }, acting: Acting) => Promise<T>): Promise<T> {
    const principal = context.get("principal");
    if (principal?.kind !== "session") {
      throw new ProblemError("unauthenticated", UNAUTHENTICATED);
    }
    const tenant = tenantOf(context);
    const ipPrefix = networkPrefixOf(context.get("clientIp")) ?? null;
    const outcome = await tenant.withTenant(async (tx) => {
      const profile = await accountProfileRepository(tx).profile();
      if (profile === undefined) {
        return undefined;
      }
      const actor: AuditActor = { type: "account", accountId: principal.accountId, label: profile.displayName };
      return {
        value: await work(
          { store: teamRepository(tx), audit: createAuditWriter({ store: auditEventRepository(tx), newId: uuidv7 }) },
          { workspaceId: tenant.workspaceId, actor, ipPrefix },
        ),
      };
    });
    if (outcome === undefined) {
      throw new ProblemError("not_found", NO_SUCH_TEAM);
    }
    return outcome.value;
  }

  return [
    route(listTeamsOperation).handle(async ({ query }, context) => {
      const tenant = tenantOf(context);
      let after: { readonly name: string; readonly id: string } | undefined;
      if (query.cursor !== undefined) {
        const [name, id, ...rest] = codec.decodeKey(query.cursor, tenant.workspaceId) ?? [];
        if (typeof name !== "string" || typeof id !== "string" || rest.length > 0) {
          throw new ProblemError("bad_request", BAD_CURSOR);
        }
        after = { name, id };
      }
      // One more than the page, to know whether another page follows.
      const fetched = await tenant.withTenant((tx) => listTeams({ store: teamRepository(tx) }, { after, limit: query.limit + 1 }));
      const items = fetched.slice(0, query.limit);
      const last = items.at(-1);
      return {
        status: 200,
        body: {
          items: items.map(summaryBody),
          nextCursor: fetched.length > query.limit && last !== undefined ? codec.encodeKey([last.name, last.id], tenant.workspaceId) : null,
        },
      };
    }),

    route(createTeamOperation).handle(async ({ body }, context) => {
      const outcome = await acting(context, ({ store, audit }, request) => createTeam({ store, audit, newId: uuidv7 }, { ...request, name: body.name, description: body.description })).catch(nameTakenWhen);
      switch (outcome.kind) {
        case "created":
          return { status: 201, ...withEntityTag(outcome.team) };
        case "invalid":
          throw invalidField(outcome);
        case "name_taken":
          throw nameTaken();
      }
    }),

    route(getTeamOperation).handle(async ({ params }, context) => {
      const tenant = tenantOf(context);
      const team = await tenant.withTenant((tx) => readTeam({ store: teamRepository(tx) }, { teamId: params.id }));
      if (team === undefined) {
        throw new ProblemError("not_found", NO_SUCH_TEAM);
      }
      return { status: 200, ...withEntityTag(team) };
    }),

    route(updateTeamOperation).handle(async ({ params, body }, context) => {
      const expectedVersions = acceptedVersions(context.req.header("if-match"));
      const outcome = await acting(context, ({ store, audit }, request) => updateTeam({ store, audit }, { ...request, teamId: params.id, patch: body, expectedVersions })).catch(nameTakenWhen);
      switch (outcome.kind) {
        case "updated":
        case "unchanged":
          return { status: 200, ...withEntityTag(outcome.team) };
        case "invalid":
          throw invalidField(outcome);
        case "name_taken":
          throw nameTaken();
        case "stale":
          throw new ProblemError("precondition_failed", STALE_VERSION);
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_TEAM);
      }
    }),

    route(deleteTeamOperation).handle(async ({ params }, context) => {
      const deleted = await acting(context, ({ store, audit }, request) => deleteTeam({ store, audit }, { ...request, teamId: params.id }));
      if (!deleted) {
        throw new ProblemError("not_found", NO_SUCH_TEAM);
      }
      return { status: 204 };
    }),

    route(replaceTeamMembersOperation).handle(async ({ params, body }, context) => {
      const outcome = await acting(context, ({ store, audit }, request) => replaceTeamMembers({ store, audit }, { ...request, teamId: params.id, accountIds: body.accountIds }));
      switch (outcome.kind) {
        case "replaced":
        case "unchanged":
          return { status: 200, ...withEntityTag(outcome.team) };
        case "unknown_members":
          throw new ProblemError("validation_failed", NOT_MEMBERS, { errors: [{ path: "accountIds", code: "unknown_member" }] });
        case "not_found":
          throw new ProblemError("not_found", NO_SUCH_TEAM);
      }
    }),
  ];
}
