import { generateApiToken, sessionCookieSpec } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.ts";
import { newSessionToken } from "../../src/auth/session-token.ts";
import { adapters, fakeAuthStore, fakeDatabase, recordingLogger, serverConfig } from "../support.ts";

// Stage 4 of the chain (doc 01 section 4) on the probe routes: `GET /health`, `/ready`
// and `/version` declare rate `none`, so the per-IP stage takes no token for them and
// the authentication stage must not turn them into an unthrottled credential lookup
// (T9, doc 04 sections 4.1 and 9.2: probes are unauthenticated). The sinks are the store's two
// lookups, reached through the authenticators the server registers itself.

const COOKIE_NAME = sessionCookieSpec(serverConfig().APP_ORIGIN).name;

function setup() {
  const lookups = { api: 0, session: 0 };
  const server = createServer({
    authStore: fakeAuthStore({
      lookupApiToken: () => {
        lookups.api += 1;
        return Promise.resolve(undefined);
      },
      lookupSession: () => {
        lookups.session += 1;
        return Promise.resolve(undefined);
      },
    }),
    config: serverConfig(),
    adapters: adapters(),
    modules: [],
    migrations: [],
    logger: recordingLogger(),
    database: fakeDatabase(),
  });
  return { server, lookups };
}

const get = (path: string, headers: Record<string, string>): Request => new Request(`http://localhost${path}`, { headers });
const bearer = (): Record<string, string> => ({ authorization: `Bearer ${generateApiToken().value}` });
const cookie = (): Record<string, string> => ({ cookie: `${COOKIE_NAME}=${newSessionToken().value}` });

describe("credentials on the probe routes", () => {
  it.each(["/health", "/ready", "/version"])("%s looks up no API token and no session", async (path) => {
    const { server, lookups } = setup();
    const withBearer = await server.fetch(get(path, bearer()));
    const withCookie = await server.fetch(get(path, cookie()));
    expect(withBearer.status).not.toBe(401);
    expect(withCookie.status).not.toBe(401);
    expect(lookups).toEqual({ api: 0, session: 0 });
  });

  it("answers /health and /version 200 to a request that carries a credential", async () => {
    const { server } = setup();
    for (const path of ["/health", "/version"]) {
      expect((await server.fetch(get(path, bearer()))).status, path).toBe(200);
      expect((await server.fetch(get(path, cookie()))).status, path).toBe(200);
    }
  });

  it("still looks the credential up on an operation that takes a rate token", async () => {
    const { server, lookups } = setup();
    await server.fetch(get("/api/config", bearer()));
    await server.fetch(get("/api/config", cookie()));
    expect(lookups).toEqual({ api: 1, session: 1 });
  });
});
