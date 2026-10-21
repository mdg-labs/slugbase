import { vi } from "vitest";
import { ACCOUNT_BODY, ME_PATH, json, meOf, problem, signedIn } from "./support.tsx";

/** A request an admin test server received. */
export interface AdminCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** Answers a route; `call` counts from 1 per route, and the last answer of a list repeats. */
export type AdminAnswer = (call: number) => Response | Promise<Response>;

export interface AdminServerOptions {
  isInstanceAdmin?: boolean;
  mfaEnabled?: boolean;
  /** The answers by `"METHOD /path"`; a route without one answers 404. */
  routes?: Readonly<Record<string, AdminAnswer | readonly AdminAnswer[]>>;
  /** The answer to `GET /me`, in place of the account, by call. */
  me?: AdminAnswer;
}

export interface AdminServer {
  /** The requests of a method and path, in order. */
  received(method: string, path: string): readonly AdminCall[];
  /** Every `/instance/` request, whatever the method. */
  instanceCalls(): readonly AdminCall[];
}

/**
 * A signed-in instance admin's server: the shared session answers, the account with the admin flag and second factor
 * as chosen, and the routes of a test. It records the requests so a test can tell what was sent.
 */
export function stubAdminServer({ isInstanceAdmin = true, mfaEnabled = true, routes = {}, me }: AdminServerOptions = {}): AdminServer {
  const calls: AdminCall[] = [];
  const counts = new Map<string, number>();
  const locale = globalThis.navigator.languages.some((language) => language.toLowerCase().startsWith("de")) ? "de" : "en";
  const account = { ...ACCOUNT_BODY, locale, isInstanceAdmin, mfaEnabled };
  let meCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      if (pathname === ME_PATH && request.method === "GET") {
        meCalls += 1;
        return Promise.resolve(me === undefined ? json(meOf(account)) : me(meCalls));
      }
      return signedIn(request, async () => {
        const text = await request.clone().text();
        calls.push({ method: request.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
        const key = `${request.method} ${pathname}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        const route = routes[key];
        if (route === undefined) {
          return problem(404, "not_found", "req-404");
        }
        const answers = Array.isArray(route) ? (route as readonly AdminAnswer[]) : [route as AdminAnswer];
        const answer = answers[Math.min(count, answers.length) - 1];
        return answer === undefined ? problem(500, "internal", "req-500") : answer(count);
      });
    }),
  );
  return {
    received: (method, path) => calls.filter((call) => call.method === method && call.path === path),
    instanceCalls: () => calls.filter((call) => call.path.startsWith("/api/v1/instance/")),
  };
}
