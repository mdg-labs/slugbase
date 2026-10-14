import { sessionCookieSpec } from "@slugbase/core";
import type { SessionRecord } from "@slugbase/db";
import { describe, expect, it } from "vitest";
import { createSessionAuthenticator } from "../../src/auth/authenticator.ts";
import { newSessionToken } from "../../src/auth/session-token.ts";

const SESSION: SessionRecord = {
  sessionId: "0192f3a0-0000-7000-8000-0000000000a1",
  accountId: "0192f3a0-0000-7000-8000-0000000000b1",
  level: "full",
  activeWorkspaceId: null,
  reauthAt: null,
  isInstanceAdmin: false,
};

function setup(answer: SessionRecord | undefined | Error, origin = "https://bookmarks.example.com") {
  const lookups: Buffer[] = [];
  const authenticator = createSessionAuthenticator({
    cookie: sessionCookieSpec(origin),
    store: {
      lookupSession: (hash) => {
        lookups.push(hash);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  });
  return { authenticator, lookups };
}

describe("the session cookie authenticator", () => {
  it("looks the session up by the hash of the cookie's token and returns its principal", async () => {
    const { authenticator, lookups } = setup(SESSION);
    const token = newSessionToken();
    const principal = await authenticator.authenticate(`theme=dark; __Host-slugbase_session=${token.value}`);
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.equals(token.hash)).toBe(true);
    expect(principal).toEqual({
      kind: "session",
      sessionId: SESSION.sessionId,
      accountId: SESSION.accountId,
      activeWorkspaceId: undefined,
      instanceAdmin: false,
    });
  });

  it("carries the workspace, the admin flag and the re-authentication time of the session", async () => {
    const reauthAt = new Date("2026-10-14T10:00:00Z");
    const { authenticator } = setup({ ...SESSION, activeWorkspaceId: "0192f3a0-0000-7000-8000-0000000000c1", isInstanceAdmin: true, reauthAt });
    const principal = await authenticator.authenticate(`__Host-slugbase_session=${newSessionToken().value}`);
    expect(principal).toMatchObject({ activeWorkspaceId: "0192f3a0-0000-7000-8000-0000000000c1", instanceAdmin: true, reauthAt });
  });

  it("marks a partial session as waiting for its second factor", async () => {
    const { authenticator } = setup({ ...SESSION, level: "partial" });
    const principal = await authenticator.authenticate(`__Host-slugbase_session=${newSessionToken().value}`);
    expect(principal).toMatchObject({ mfaPending: true });
  });

  it("is no principal when the database does not know the token", async () => {
    const { authenticator, lookups } = setup(undefined);
    expect(await authenticator.authenticate(`__Host-slugbase_session=${newSessionToken().value}`)).toBeUndefined();
    expect(lookups).toHaveLength(1);
  });

  it.each([
    ["another cookie only", "theme=dark"],
    ["the plain name over https", "slugbase_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["a value that is not a token", "__Host-slugbase_session=not-a-token"],
    ["an empty value", "__Host-slugbase_session="],
  ])("does not ask the database for %s", async (_name, header) => {
    const { authenticator, lookups } = setup(SESSION);
    expect(await authenticator.authenticate(header)).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  it("reads the plain cookie name over http", async () => {
    const { authenticator, lookups } = setup(SESSION, "http://localhost:5173");
    const token = newSessionToken();
    expect(await authenticator.authenticate(`slugbase_session=${token.value}`)).toBeDefined();
    expect(lookups[0]?.equals(token.hash)).toBe(true);
    expect(await authenticator.authenticate(`__Host-slugbase_session=${token.value}`)).toBeUndefined();
  });

  it("fails when the database cannot answer, rather than treating the request as anonymous", async () => {
    const { authenticator } = setup(new Error("database down"));
    await expect(authenticator.authenticate(`__Host-slugbase_session=${newSessionToken().value}`)).rejects.toThrow("database down");
  });
});
