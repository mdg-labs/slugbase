import { vi } from "vitest";
import {
  ACCOUNT_BODY,
  ACTIVE_WORKSPACE_PATH,
  CONFIG_BODY,
  ME_PATH,
  SESSION_BODY,
  SESSION_PATH,
  WORKSPACES_PATH,
  json,
  problem,
} from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

export const LOGOUT_PATH = "/api/v1/auth/logout";

export interface Workspace {
  readonly id: string;
  readonly name: string;
}

export const HOME: Workspace = { id: "0192f3a0-cccc-7000-8000-000000000001", name: "Home" };
export const TEAM: Workspace = { id: "0192f3a0-cccc-7000-8000-000000000002", name: "Team" };
export const NEW_ID = "0192f3a0-cccc-7000-8000-000000000003";

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface WorkspaceServerOptions {
  /** The workspaces the account is a member of. */
  readonly workspaces?: readonly Workspace[];
  /** The one the session acts in; null for none. */
  readonly active?: string | null;
  readonly canCreate?: boolean;
  /** Answers `GET /workspaces` instead of the list; once per call. */
  readonly list?: Transport;
  /** Answers `GET /me` instead of the account. */
  readonly me?: Transport;
  /** Answers `PUT /session/active-workspace` instead of switching. */
  readonly put?: (request: Request, count: number) => Promise<Response>;
  /** Answers `POST /workspaces` instead of creating. */
  readonly post?: (request: Request, count: number) => Promise<Response>;
  readonly extraConfig?: object;
}

/**
 * A server with a signed-in account that is a member of some workspaces and acts in one. It switches and creates
 * as the real one does unless a test answers the request itself, and it records every call except the reads of
 * the configuration and the session.
 */
export function stubWorkspaceServer(options: WorkspaceServerOptions = {}) {
  const members: Workspace[] = [...(options.workspaces ?? [HOME, TEAM])];
  let active: string | null = options.active === undefined ? (members[0]?.id ?? null) : options.active;
  let signedOut = false;
  const calls: Call[] = [];
  const counts = new Map<string, number>();

  const memberships = () => members.map(({ id, name }) => ({ workspaceId: id, name, role: "owner" }));
  const german = globalThis.navigator.languages.some((language) => language.toLowerCase().startsWith("de"));
  const body = (): object => ({ account: { ...ACCOUNT_BODY, locale: german ? "de" : "en" }, memberships: memberships(), activeWorkspaceId: active });

  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json({ ...CONFIG_BODY, ...options.extraConfig });
    }
    if (pathname === SESSION_PATH) {
      return signedOut ? problem(401, "unauthenticated", "req-session") : json(SESSION_BODY);
    }
    const text = await request.clone().text();
    calls.push({ method: request.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    const key = `${request.method} ${pathname}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (pathname === LOGOUT_PATH) {
      signedOut = true;
      return new Response(null, { status: 204 });
    }
    if (pathname === ME_PATH && request.method === "GET") {
      return options.me === undefined ? json(body()) : options.me(request);
    }
    if (pathname === WORKSPACES_PATH && request.method === "GET") {
      if (options.list !== undefined) {
        return options.list(request);
      }
      return json({
        items: members.map(({ id, name }) => ({ id, name, role: "owner", memberCount: 1 })),
        canCreate: options.canCreate ?? false,
      });
    }
    if (pathname === WORKSPACES_PATH && request.method === "POST") {
      if (options.post !== undefined) {
        return options.post(request, count);
      }
      const { name } = JSON.parse(text) as { name: string };
      members.push({ id: NEW_ID, name });
      return json({ id: NEW_ID, name, role: "owner", memberCount: 1 }, { status: 201 });
    }
    if (pathname === ACTIVE_WORKSPACE_PATH && request.method === "PUT") {
      if (options.put !== undefined) {
        return options.put(request, count);
      }
      active = (JSON.parse(text) as { workspaceId: string }).workspaceId;
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected call ${request.method} ${pathname}`);
  });
  vi.stubGlobal("fetch", fetch);

  return {
    fetch,
    calls: (method: string, path: string): Call[] => calls.filter((call) => call.method === method && call.path === path),
    /** The workspace the server has the session in. */
    active: (): string | null => active,
    /** Makes the server switch the session, for a test that answers the request itself. */
    activate: (id: string): void => {
      active = id;
    },
  };
}
