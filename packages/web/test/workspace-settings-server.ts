import { vi } from "vitest";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, WORKSPACES_PATH, WORKSPACE_ID, json, problem } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

export const WORKSPACE_PATH = "/api/v1/workspace";

export type Role = "owner" | "admin" | "member";

export const MEMBERS_PATH = "/api/v1/members";

export interface TestMember {
  readonly accountId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
  readonly joinedAt: string;
  readonly lastActiveAt: string | null;
}

/** The signed-in account as the member list holds it. */
export const SELF: TestMember = {
  accountId: ACCOUNT_BODY.id,
  displayName: ACCOUNT_BODY.displayName,
  email: ACCOUNT_BODY.email,
  role: "owner",
  joinedAt: "2026-09-01T08:00:00.000Z",
  lastActiveAt: "2026-10-18T09:30:00.000Z",
};

export const GRACE: TestMember = {
  accountId: "0192f3a0-bbbb-7000-8000-000000000002",
  displayName: "Grace Hopper",
  email: "grace@example.org",
  role: "member",
  joinedAt: "2026-09-05T08:00:00.000Z",
  lastActiveAt: null,
};

export interface WorkspaceSettingsServerOptions {
  /** The caller's role in the workspace. */
  readonly role?: Role;
  readonly name?: string;
  readonly version?: number;
  /** Answers `GET /workspace` instead of the workspace; `call` counts from 1. */
  readonly get?: (call: number) => Response | Promise<Response>;
  /** Answers `PATCH /workspace` instead of renaming; `call` counts from 1. */
  readonly patch?: (call: number, request: Request) => Response | Promise<Response>;
  /** Answers every other call, such as the members operations. */
  readonly other?: Transport;
  /** The account acts in no workspace. */
  readonly noWorkspace?: boolean;
  /** The members `GET /members` lists, in one page unless `pageSize` splits them. */
  readonly members?: readonly TestMember[];
  readonly pageSize?: number;
  /** Answers `GET /members` instead of the list; `call` counts from 1. */
  readonly membersGet?: (call: number) => Response | Promise<Response>;
  /** Answers `PATCH /members/{accountId}` instead of changing the role; `call` counts from 1. */
  readonly memberPatch?: (call: number, request: Request) => Response | Promise<Response>;
  /** Answers `DELETE /members/{accountId}` instead of removing the member; `call` counts from 1. */
  readonly memberDelete?: (call: number, request: Request) => Response | Promise<Response>;
  /** Answers `POST /workspace/leave` instead of ending the caller's membership; `call` counts from 1. */
  readonly leave?: (call: number, request: Request) => Response | Promise<Response>;
  /** Answers `POST /workspace/transfer-ownership` instead of transferring; `call` counts from 1. */
  readonly transfer?: (call: number, request: Request) => Response | Promise<Response>;
  /** Answers `DELETE /workspace` instead of accepting the deletion; `call` counts from 1. */
  readonly workspaceDelete?: (call: number, request: Request) => Response | Promise<Response>;
  /** Where the session acts once the caller has left or the workspace is deleted: in another workspace, or in none. */
  readonly afterLeaving?: "other" | "none";
}

export const OTHER_WORKSPACE_ID = "0192f3a0-cccc-7000-8000-000000000009";

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly ifMatch: string | null;
  readonly body: unknown;
}

/**
 * A server with a signed-in account that is a member of one workspace with the given role. A rename applies as the
 * real one does: it needs the version the workspace has and moves it by one.
 */
export function stubWorkspaceSettingsServer(options: WorkspaceSettingsServerOptions = {}) {
  let role: Role = options.role ?? "owner";
  let name = options.name ?? "Ada's Workspace";
  let members: TestMember[] = [...(options.members ?? [{ ...SELF, role: options.role ?? "owner" }, GRACE])];
  let version = options.version ?? 3;
  let left = false;
  const received: Received[] = [];
  const counts = new Map<string, number>();

  const workspace = () => ({
    id: WORKSPACE_ID,
    name,
    role,
    memberCount: 2,
    createdAt: "2026-09-01T08:00:00.000Z",
    version,
  });
  const other = { workspaceId: OTHER_WORKSPACE_ID, name: "Second Workspace", role: "member" as const };
  const me = () =>
    left
      ? {
          account: ACCOUNT_BODY,
          memberships: options.afterLeaving === "other" ? [other] : [],
          activeWorkspaceId: options.afterLeaving === "other" ? OTHER_WORKSPACE_ID : null,
        }
      : {
          account: ACCOUNT_BODY,
          memberships: [{ workspaceId: WORKSPACE_ID, name, role }],
          activeWorkspaceId: options.noWorkspace === true ? null : WORKSPACE_ID,
        };
  /** Ends a membership as the server does; the answer is the document of the departure or a problem. */
  const ending = (accountId: string, body: { content: "transfer" | "delete"; transferTo?: string }, byself: boolean): Response => {
    const member = members.find((candidate) => candidate.accountId === accountId);
    if (member === undefined) {
      return problem(404, "not_found", "req-404");
    }
    if (member.role === "owner" && members.filter((candidate) => candidate.role === "owner").length === 1) {
      return problem(409, "last_owner", "req-409");
    }
    const recipient =
      body.transferTo ??
      (byself
        ? members
            .filter((candidate) => candidate.role === "owner" && candidate.accountId !== accountId)
            .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0]?.accountId
        : SELF.accountId);
    if (body.content === "transfer" && !members.some((candidate) => candidate.accountId === recipient && candidate.accountId !== accountId)) {
      return problem(404, "not_found", "req-404");
    }
    members = members.filter((candidate) => candidate.accountId !== accountId);
    return json({ content: body.content, transferTo: recipient ?? SELF.accountId });
  };

  const transport = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json(CONFIG_BODY);
    }
    if (pathname === SESSION_PATH) {
      return json(SESSION_BODY);
    }
    const text = request.method === "GET" ? "" : await request.clone().text();
    received.push({
      method: request.method,
      path: pathname,
      ifMatch: request.headers.get("If-Match"),
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    });
    const key = `${request.method} ${pathname}`;
    const call = (counts.get(key) ?? 0) + 1;
    counts.set(key, call);
    if (pathname === ME_PATH && request.method === "GET") {
      return json(me());
    }
    if (pathname === WORKSPACES_PATH && request.method === "GET") {
      if (left) {
        return json({
          items: options.afterLeaving === "other" ? [{ id: OTHER_WORKSPACE_ID, name: other.name, role: other.role, memberCount: 3 }] : [],
          canCreate: false,
        });
      }
      return json({ items: [{ id: WORKSPACE_ID, name, role, memberCount: 2 }], canCreate: false });
    }
    if (pathname === WORKSPACE_PATH && request.method === "GET") {
      if (left) {
        return problem(404, "not_found", "req-404");
      }
      return options.get === undefined ? json(workspace(), { headers: { ETag: `"${String(version)}"` } }) : options.get(call);
    }
    if (pathname === WORKSPACE_PATH && request.method === "DELETE") {
      const answer = options.workspaceDelete === undefined ? new Response(null, { status: 202 }) : await options.workspaceDelete(call, request);
      // An accepted deletion marks the workspace as being deleted: the session no longer acts in it.
      left = left || answer.ok;
      return answer;
    }
    if (pathname === WORKSPACE_PATH && request.method === "PATCH") {
      if (options.patch !== undefined) {
        return options.patch(call, request);
      }
      if (request.headers.get("If-Match") !== `"${String(version)}"`) {
        return json(
          { type: "https://slugbase.app/problems/precondition_failed", title: "x", status: 412, code: "precondition_failed", detail: "x", requestId: "req-412" },
          { status: 412, contentType: "application/problem+json" },
        );
      }
      name = ((JSON.parse(text) as { name: string }).name);
      version += 1;
      return json(workspace(), { headers: { ETag: `"${String(version)}"` } });
    }
    if (pathname === MEMBERS_PATH && request.method === "GET") {
      if (options.membersGet !== undefined) {
        return options.membersGet(call);
      }
      const size = options.pageSize ?? members.length;
      const start = Number(new URL(request.url).searchParams.get("cursor") ?? 0);
      const next = start + size;
      return json({ items: members.slice(start, next), nextCursor: next < members.length ? String(next) : null });
    }
    if (pathname.startsWith(`${MEMBERS_PATH}/`) && request.method === "PATCH") {
      if (options.memberPatch !== undefined) {
        return options.memberPatch(call, request);
      }
      const accountId = pathname.slice(MEMBERS_PATH.length + 1);
      const requested = (JSON.parse(text) as { role: Role }).role;
      const member = members.find((candidate) => candidate.accountId === accountId);
      if (member === undefined) {
        return problem(404, "not_found", "req-404");
      }
      if (member.role === "owner" && requested !== "owner" && members.filter((candidate) => candidate.role === "owner").length === 1) {
        return problem(409, "last_owner", "req-409");
      }
      const changed = { ...member, role: requested };
      members = members.map((candidate) => (candidate.accountId === accountId ? changed : candidate));
      if (accountId === SELF.accountId) {
        // The caller's own role moves, and the session's token with it.
        role = requested;
      }
      return json(changed);
    }
    if (pathname.startsWith(`${MEMBERS_PATH}/`) && request.method === "DELETE") {
      if (options.memberDelete !== undefined) {
        return options.memberDelete(call, request);
      }
      return ending(pathname.slice(MEMBERS_PATH.length + 1), JSON.parse(text) as { content: "transfer" | "delete"; transferTo?: string }, false);
    }
    if (pathname === `${WORKSPACE_PATH}/leave` && request.method === "POST") {
      if (options.leave !== undefined) {
        return options.leave(call, request);
      }
      const answer = ending(SELF.accountId, JSON.parse(text) as { content: "transfer" | "delete"; transferTo?: string }, true);
      left = answer.ok;
      return answer;
    }
    if (pathname === `${WORKSPACE_PATH}/transfer-ownership` && request.method === "POST") {
      if (options.transfer !== undefined) {
        return options.transfer(call, request);
      }
      const { accountId, demoteSelf } = JSON.parse(text) as { accountId: string; demoteSelf: boolean };
      const recipient = members.find((candidate) => candidate.accountId === accountId);
      if (recipient === undefined) {
        return problem(404, "not_found", "req-404");
      }
      const promoted = { ...recipient, role: "owner" as const };
      members = members.map((candidate) => (candidate.accountId === accountId ? promoted : candidate));
      if (demoteSelf) {
        // The caller steps down, and the session's token is rotated with it.
        members = members.map((candidate) => (candidate.accountId === SELF.accountId ? { ...candidate, role: "admin" as const } : candidate));
        role = "admin";
      }
      return json(promoted);
    }
    if (options.other !== undefined) {
      return options.other(request);
    }
    throw new Error(`unexpected call ${request.method} ${pathname}`);
  });
  vi.stubGlobal("fetch", transport);

  return {
    fetch: transport,
    received: (method: string, path: string): Received[] => received.filter((call) => call.method === method && call.path === path),
    /** Another client renames the workspace: its version moves on without this page knowing. */
    renameElsewhere: (next: string): void => {
      name = next;
      version += 1;
    },
  };
}
