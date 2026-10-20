import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthStore, type AuthStore, type NewOidcLoginState } from "../src/index.ts";
import { systemOperations } from "../src/system/registry.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { asSystem, freshId, freshToken, seedAccount, sessionRows, sha256 } from "./support/auth-fixture.ts";

// The OIDC sign-in's system operations (doc 05 sections 2.1 and 3.3, doc 02
// section 2.8, doc 10 T4, T17 and T20). The failure scenarios: a state that
// works twice, after its expiry or for another provider; a sign-in that creates
// a session for an unknown identity or a disabled account; the application role
// reading a state, or one account's identities from another's.

const HOOK_TIMEOUT_MS = 300_000;
const SUB = "subject-1";

let db: TestDatabase;
let store: AuthStore;

function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

beforeAll(async () => {
  db = await createTestDatabase();
  store = createAuthStore({ url: appUrl(db), poolSize: 4 });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await store.close();
  await db.drop();
}, HOOK_TIMEOUT_MS);

let emailNumber = 0;

async function account(options: { disabled?: boolean; mfa?: boolean; noPassword?: boolean } = {}): Promise<string> {
  emailNumber += 1;
  const id = freshId();
  await seedAccount(db, { id, email: `oidc${String(emailNumber)}@example.test`, passwordHash: options.noPassword === true ? null : "$argon2id$stub", disabledAt: options.disabled === true ? new Date() : null });
  if (options.mfa === true) {
    await asSystem(db, (tx) => tx`UPDATE accounts SET mfa_secret = ${Buffer.alloc(40, 2)}, mfa_secret_key_id = 'k1', mfa_enabled_at = now() WHERE id = ${id}`);
  }
  return id;
}

async function link(accountId: string, provider = "idp", subject = SUB): Promise<string> {
  const id = freshId();
  // Linking is the work of a later operation, so the fixture writes the row as the table owner, acting as the account.
  await db.owner.begin(async (tx) => {
    await tx`SELECT set_config('app.account_id', ${accountId}, true)`;
    await tx`
      INSERT INTO account_identities (id, account_id, provider, subject, email_at_link)
      VALUES (${id}, ${accountId}, ${provider}, ${subject}, 'linked@example.test')`;
  });
  return id;
}

function newState(overrides: Partial<NewOidcLoginState> = {}): NewOidcLoginState {
  return {
    stateHash: freshToken().hash,
    provider: "idp",
    intent: "login",
    nonce: "nonce-1",
    codeVerifier: { ciphertext: new Uint8Array(40).fill(7), keyId: "k1" },
    returnTo: "/go/docs",
    linkAccountId: null,
    ...overrides,
  };
}

function signIn(overrides: Partial<Parameters<AuthStore["signInWithIdentity"]>[0]> = {}): Parameters<AuthStore["signInWithIdentity"]>[0] {
  return {
    provider: "idp",
    subject: SUB,
    sessionId: freshId(),
    ipPrefix: "203.0.0.0/16",
    userAgent: "test agent",
    tokenHash: freshToken().hash,
    replacedTokenHash: null,
    ...overrides,
  };
}

describe("the OIDC system operations", () => {
  it("are registered", () => {
    expect(systemOperations).toEqual(
      expect.arrayContaining(["sys_oidc_state_create", "sys_oidc_state_consume", "sys_identity_sign_in", "sys_identity_link", "sys_identity_link_by_email", "sys_identity_unlink", "sys_identity_reauth", "sys_password_set_initial"]),
    );
  });
});

describe("the login state", () => {
  it("is returned once, with what was stored, and then not again", async () => {
    const state = newState();
    await store.createOidcLoginState(state);

    const consumed = await store.consumeOidcLoginState(state.stateHash, "idp");
    expect(consumed).toEqual({
      intent: "login",
      nonce: "nonce-1",
      codeVerifier: { ciphertext: new Uint8Array(40).fill(7), keyId: "k1" },
      returnTo: "/go/docs",
      linkAccountId: null,
      invitationTokenHash: null,
    });
    expect(await store.consumeOidcLoginState(state.stateHash, "idp")).toBeUndefined();
  });

  it("is returned to one of two callbacks that arrive together", async () => {
    const state = newState();
    await store.createOidcLoginState(state);
    const results = await Promise.all(Array.from({ length: 6 }, () => store.consumeOidcLoginState(state.stateHash, "idp")));
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it("is not returned for an unknown state, and not for another provider, which leaves it to its own", async () => {
    const state = newState();
    await store.createOidcLoginState(state);
    expect(await store.consumeOidcLoginState(freshToken().hash, "idp")).toBeUndefined();
    expect(await store.consumeOidcLoginState(state.stateHash, "other")).toBeUndefined();
    expect(await store.consumeOidcLoginState(state.stateHash, "idp")).toMatchObject({ nonce: "nonce-1" });
  });

  it("is not returned after its 10 minutes, and expires 10 minutes after it was stored", async () => {
    const state = newState();
    await store.createOidcLoginState(state);
    const rows = await asSystem(db, (tx) => tx<{ minutes: string }[]>`
      SELECT extract(epoch FROM expires_at - now()) / 60 AS minutes FROM oidc_login_states WHERE state_hash = ${state.stateHash}`);
    const minutes = Number(rows[0]?.minutes);
    expect(minutes).toBeGreaterThan(9.5);
    expect(minutes).toBeLessThanOrEqual(10);

    const expired = freshToken().hash;
    await asSystem(db, (tx) => tx`
      INSERT INTO oidc_login_states (state_hash, provider, intent, nonce, code_verifier, code_verifier_key_id, return_to, expires_at)
      VALUES (${expired}, 'idp', 'login', 'nonce-1', ${Buffer.alloc(40, 7)}, 'k1', '/', now() - interval '1 second')`);
    expect(await store.consumeOidcLoginState(expired, "idp")).toBeUndefined();
  });

  it("keeps the link account for the intents that carry one, and refuses it for a login", async () => {
    const holder = await account();
    const linked = newState({ intent: "link", linkAccountId: holder });
    await store.createOidcLoginState(linked);
    expect(await store.consumeOidcLoginState(linked.stateHash, "idp")).toMatchObject({ intent: "link", linkAccountId: holder });

    await expect(store.createOidcLoginState(newState({ linkAccountId: holder }))).rejects.toMatchObject({ code: "22023" });
    await expect(store.createOidcLoginState(newState({ intent: "link", linkAccountId: null }))).rejects.toMatchObject({ code: "22023" });
  });

  it("refuses a return path that is not relative, and a state hash that is not 32 bytes", async () => {
    await expect(store.createOidcLoginState(newState({ returnTo: "https://evil.example/" }))).rejects.toMatchObject({ code: "22023" });
    await expect(store.createOidcLoginState(newState({ stateHash: Buffer.alloc(31) }))).rejects.toThrow(RangeError);
    await expect(store.consumeOidcLoginState(Buffer.alloc(31), "idp")).rejects.toThrow(RangeError);
  });

  it("is out of the application role's reach: it neither reads nor writes the table", async () => {
    await expect(db.app.unsafe("SELECT * FROM public.oidc_login_states")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("INSERT INTO public.oidc_login_states (state_hash) VALUES ('\\x00')")).rejects.toMatchObject({ code: "42501" });
    const rows = await db.owner<{ forced: boolean; policies: number }[]>`
      SELECT c.relforcerowsecurity AS forced, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.oid = 'public.oidc_login_states'::regclass`;
    expect([...rows]).toEqual([{ forced: true, policies: 0 }]);
  });
});

describe("signing in with a linked identity", () => {
  it("creates a full session of the identity's account and records the sign-in", async () => {
    const holder = await account();
    const identityId = await link(holder);
    const request = signIn();

    expect(await store.signInWithIdentity(request)).toBe("signed_in");

    const sessions = await sessionRows(db, holder);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: request.sessionId, level: "full", remember: false, ip_prefix: "203.0.0.0/16", user_agent: "test agent" });
    expect(sessions[0]?.token_hash.equals(request.tokenHash)).toBe(true);
    const days = ((sessions[0]?.expires_at.getTime() ?? 0) - (sessions[0]?.created_at.getTime() ?? 0)) / 86_400_000;
    const cap = ((sessions[0]?.absolute_expires_at.getTime() ?? 0) - (sessions[0]?.created_at.getTime() ?? 0)) / 86_400_000;
    expect([Math.round(days), Math.round(cap)]).toEqual([30, 180]);
    const recorded = await asSystem(db, async (tx) => ({
      identity: (await tx<{ last_used_at: Date | null }[]>`SELECT last_used_at FROM account_identities WHERE id = ${identityId}`)[0],
      account: (await tx<{ last_sign_in_at: Date | null }[]>`SELECT last_sign_in_at FROM accounts WHERE id = ${holder}`)[0],
    }));
    expect(recorded.identity?.last_used_at).toBeInstanceOf(Date);
    expect(recorded.account?.last_sign_in_at).toBeInstanceOf(Date);
    expect(await store.lookupSession(request.tokenHash)).toMatchObject({ accountId: holder, level: "full" });
  });

  it("creates a full session for an account whose second factor is on: the provider is trusted for it", async () => {
    const holder = await account({ mfa: true });
    await link(holder, "idp", "mfa-subject");
    const request = signIn({ subject: "mfa-subject" });

    expect(await store.signInWithIdentity(request)).toBe("signed_in");
    expect((await sessionRows(db, holder)).map((row) => row.level)).toEqual(["full"]);
    expect(await store.createSession({ ...request, id: freshId(), accountId: holder, level: "full", remember: false, tokenHash: freshToken().hash })).toBe(false);
  });

  it("deletes the session of the cookie the request carried, with the creation of the new one", async () => {
    const holder = await account();
    await link(holder, "idp", "replace-subject");
    const old = freshToken();
    await asSystem(db, (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${old.hash}, ${holder}, 'full', false, now() + interval '1 day', now() + interval '1 day')`);

    expect(await store.signInWithIdentity(signIn({ subject: "replace-subject", replacedTokenHash: old.hash }))).toBe("signed_in");
    expect(await sessionRows(db, holder)).toHaveLength(1);
    expect(await store.lookupSession(old.hash)).toBeUndefined();
  });

  it("creates nothing for an identity nobody linked, for another provider's subject, or for a disabled account", async () => {
    const holder = await account();
    await link(holder, "idp", "known");
    const disabled = await account({ disabled: true });
    await link(disabled, "idp", "disabled-subject");

    expect(await store.signInWithIdentity(signIn({ subject: "unknown" }))).toBe("refused");
    expect(await store.signInWithIdentity(signIn({ provider: "other", subject: "known" }))).toBe("refused");
    expect(await store.signInWithIdentity(signIn({ subject: "disabled-subject" }))).toBe("refused");
    expect(await sessionRows(db, holder)).toEqual([]);
    expect(await sessionRows(db, disabled)).toEqual([]);
  });

  it("leaves nothing behind when the new token is already in use: no session is replaced and no sign-in recorded", async () => {
    const holder = await account();
    const identityId = await link(holder, "idp", "clash-subject");
    const taken = freshToken();
    expect(await store.signInWithIdentity(signIn({ subject: "clash-subject", tokenHash: taken.hash }))).toBe("signed_in");
    const survivor = freshToken();
    await asSystem(db, (tx) => tx`
      INSERT INTO sessions (id, token_hash, account_id, level, remember, expires_at, absolute_expires_at)
      VALUES (${freshId()}, ${survivor.hash}, ${holder}, 'full', false, now() + interval '1 day', now() + interval '1 day')`);
    await asSystem(db, (tx) => tx`UPDATE account_identities SET last_used_at = NULL WHERE id = ${identityId}`);

    await expect(store.signInWithIdentity(signIn({ subject: "clash-subject", tokenHash: taken.hash, replacedTokenHash: survivor.hash }))).rejects.toMatchObject({ code: "23505" });

    expect(await store.lookupSession(survivor.hash)).toMatchObject({ accountId: holder });
    const rows = await asSystem(db, (tx) => tx<{ last_used_at: Date | null }[]>`SELECT last_used_at FROM account_identities WHERE id = ${identityId}`);
    expect(rows[0]?.last_used_at).toBeNull();
  });

  it("rejects hashes that are not 32 bytes", async () => {
    await expect(store.signInWithIdentity(signIn({ tokenHash: Buffer.alloc(31) }))).rejects.toThrow(RangeError);
    await expect(store.signInWithIdentity(signIn({ replacedTokenHash: sha256("x").subarray(1) }))).rejects.toThrow(RangeError);
  });
});

describe("account_identities", () => {
  it("is linked to one account at most: a provider's subject is unique", async () => {
    const first = await account();
    const second = await account();
    await link(first, "idp", "unique-subject");
    await expect(link(second, "idp", "unique-subject")).rejects.toMatchObject({ code: "23505" });
    await link(second, "other", "unique-subject");
  });

  it("is seen by its own account only, and written by the application role never", async () => {
    const mine = await account();
    const theirs = await account();
    await link(mine, "idp", "mine-subject");
    await link(theirs, "idp", "theirs-subject");

    const seen = await db.app.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${mine}, true)`;
      return [...(await tx<{ provider: string; account_id: string }[]>`SELECT provider, account_id FROM account_identities`)];
    });
    expect(seen).toEqual([{ provider: "idp", account_id: mine }]);
    await expect(db.app.unsafe("INSERT INTO public.account_identities (id, account_id, provider, subject, email_at_link) VALUES ('0192f3a0-0000-7000-8000-000000000001', '0192f3a0-0000-7000-8000-000000000002', 'idp', 'x', 'x@example.test')")).rejects.toMatchObject({ code: "42501" });
    await expect(db.app.unsafe("UPDATE public.account_identities SET subject = 'x'")).rejects.toMatchObject({ code: "42501" });
  });

  it("goes with its account", async () => {
    const holder = await account();
    await link(holder, "idp", "cascade-subject");
    await db.owner.begin(async (tx) => {
      await tx`SELECT set_config('app.account_id', ${holder}, true)`;
      await tx`DELETE FROM accounts WHERE id = ${holder}`;
    });
    const rows = await asSystem(db, (tx) => tx<{ id: string }[]>`SELECT id FROM account_identities WHERE account_id = ${holder}`);
    expect(rows).toHaveLength(0);
  });
});

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$sFLPcSAWqw4Wpd/8O0PrNw$xLekCysBXktEpmApalRynWfjPdndgkAFMEe1+x82+K4";

async function identityRows(accountId: string): Promise<{ id: string; provider: string; subject: string; email_at_link: string; last_used_at: Date | null }[]> {
  return asSystem(
    db,
    (tx) => tx<{ id: string; provider: string; subject: string; email_at_link: string; last_used_at: Date | null }[]>`
      SELECT id, provider, subject, email_at_link, last_used_at FROM account_identities WHERE account_id = ${accountId} ORDER BY id`,
  );
}

async function fullSession(accountId: string): Promise<{ id: string; hash: Buffer }> {
  const { hash } = freshToken();
  const id = freshId();
  expect(await store.createSession({ id, accountId, level: "full", remember: false, ipPrefix: null, userAgent: null, tokenHash: hash, replacedTokenHash: null })).toBe(true);
  return { id, hash };
}

describe("linking an identity", () => {
  it("adds the identity the provider asserted to the account, with the address as asserted", async () => {
    const holder = await account();
    const id = freshId();

    expect(await store.linkIdentity({ accountId: holder, id, provider: "idp", subject: "link-1", email: "Asserted@Example.test" })).toBe("linked");

    expect(await identityRows(holder)).toEqual([{ id, provider: "idp", subject: "link-1", email_at_link: "Asserted@Example.test", last_used_at: null }]);
  });

  it("keeps an identity another account holds where it is: nothing moves, and the answer is `taken`", async () => {
    const owner = await account();
    const intruder = await account();
    const id = await link(owner, "idp", "held-subject");

    expect(await store.linkIdentity({ accountId: intruder, id: freshId(), provider: "idp", subject: "held-subject", email: "x@example.test" })).toBe("taken");

    expect(await identityRows(intruder)).toEqual([]);
    expect((await identityRows(owner)).map((row) => row.id)).toEqual([id]);
  });

  it("answers `already_linked` for an identity the account holds, and changes nothing", async () => {
    const holder = await account();
    const id = await link(holder, "idp", "again-subject");

    expect(await store.linkIdentity({ accountId: holder, id: freshId(), provider: "idp", subject: "again-subject", email: "other@example.test" })).toBe("already_linked");

    expect(await identityRows(holder)).toMatchObject([{ id, email_at_link: "linked@example.test" }]);
  });

  it("links a subject of another provider, and an empty address", async () => {
    const holder = await account();
    await link(holder, "idp", "shared-subject");
    expect(await store.linkIdentity({ accountId: holder, id: freshId(), provider: "other", subject: "shared-subject", email: "" })).toBe("linked");
    expect(await identityRows(holder)).toHaveLength(2);
  });

  it("links to an account that exists and is not disabled only", async () => {
    expect(await store.linkIdentity({ accountId: freshId(), id: freshId(), provider: "idp", subject: "ghost-1", email: "" })).toBe("no_account");
    const disabled = await account({ disabled: true });
    expect(await store.linkIdentity({ accountId: disabled, id: freshId(), provider: "idp", subject: "ghost-2", email: "" })).toBe("no_account");
    expect(await identityRows(disabled)).toEqual([]);
  });

  it("links a subject to one of two accounts that ask together", async () => {
    const first = await account();
    const second = await account();
    const outcomes = await Promise.all(
      [first, second].map((accountId) => store.linkIdentity({ accountId, id: freshId(), provider: "idp", subject: "race-subject", email: "" })),
    );
    expect(outcomes.toSorted()).toEqual(["linked", "taken"]);
    expect((await identityRows(first)).length + (await identityRows(second)).length).toBe(1);
  });

  it("refuses a provider or a subject outside the table's bounds, and cuts the address", async () => {
    const holder = await account();
    await expect(store.linkIdentity({ accountId: holder, id: freshId(), provider: "", subject: "s", email: "" })).rejects.toMatchObject({ code: "22023" });
    await expect(store.linkIdentity({ accountId: holder, id: freshId(), provider: "idp", subject: "s".repeat(256), email: "" })).rejects.toMatchObject({ code: "22023" });
    expect(await store.linkIdentity({ accountId: holder, id: freshId(), provider: "idp", subject: "long-address", email: "a".repeat(400) })).toBe("linked");
    expect((await identityRows(holder))[0]?.email_at_link).toHaveLength(320);
  });
});

describe("unlinking an identity", () => {
  it("deletes the account's identity when it has a password", async () => {
    const holder = await account();
    const id = await link(holder, "idp", "unlink-1");

    expect(await store.unlinkIdentity(holder, id)).toBe("unlinked");

    expect(await identityRows(holder)).toEqual([]);
  });

  it("deletes one of two identities of an account without a password", async () => {
    const holder = await account({ noPassword: true });
    const first = await link(holder, "idp", "unlink-2a");
    const second = await link(holder, "idp", "unlink-2b");

    expect(await store.unlinkIdentity(holder, first)).toBe("unlinked");

    expect((await identityRows(holder)).map((row) => row.id)).toEqual([second]);
  });

  it("refuses the only identity of an account without a password, and deletes nothing", async () => {
    const holder = await account({ noPassword: true });
    const only = await link(holder, "idp", "unlink-3");

    expect(await store.unlinkIdentity(holder, only)).toBe("last_sign_in_method");

    expect((await identityRows(holder)).map((row) => row.id)).toEqual([only]);
  });

  it("answers an identity of another account like one that does not exist, and deletes nothing", async () => {
    const holder = await account({ noPassword: true });
    const stranger = await account();
    const theirs = await link(stranger, "idp", "unlink-4");

    expect(await store.unlinkIdentity(holder, theirs)).toBe("not_found");
    expect(await store.unlinkIdentity(holder, freshId())).toBe("not_found");

    expect((await identityRows(stranger)).map((row) => row.id)).toEqual([theirs]);
  });

  it("answers `not_found` for a disabled account", async () => {
    const holder = await account({ disabled: true });
    const id = await link(holder, "idp", "unlink-5");
    expect(await store.unlinkIdentity(holder, id)).toBe("not_found");
    expect(await identityRows(holder)).toHaveLength(1);
  });

  it("leaves one identity when two unlinks of an account without a password arrive together", async () => {
    for (let round = 0; round < 5; round += 1) {
      const holder = await account({ noPassword: true });
      const first = await link(holder, "idp", `race-a-${String(round)}`);
      const second = await link(holder, "idp", `race-b-${String(round)}`);

      const outcomes = await Promise.all([store.unlinkIdentity(holder, first), store.unlinkIdentity(holder, second)]);

      expect(outcomes.toSorted(), `round ${String(round)}`).toEqual(["last_sign_in_method", "unlinked"]);
      expect(await identityRows(holder), `round ${String(round)}`).toHaveLength(1);
    }
  });
});

describe("re-authenticating with an identity", () => {
  it("sets reauth_at of the session of the identity's account and the identity's last-used time", async () => {
    const holder = await account({ noPassword: true });
    await link(holder, "idp", "reauth-1");
    const session = await fullSession(holder);
    expect((await store.lookupSession(session.hash))?.reauthAt).toBeNull();

    expect(await store.reauthenticateWithIdentity({ sessionId: session.id, accountId: holder, provider: "idp", subject: "reauth-1" })).toBe(true);

    expect((await store.lookupSession(session.hash))?.reauthAt).toBeInstanceOf(Date);
    expect((await identityRows(holder))[0]?.last_used_at).toBeInstanceOf(Date);
  });

  it("accepts no identity of another account, however valid the session: nothing changes", async () => {
    const holder = await account({ noPassword: true });
    const stranger = await account();
    await link(stranger, "idp", "reauth-2");
    const session = await fullSession(holder);

    expect(await store.reauthenticateWithIdentity({ sessionId: session.id, accountId: holder, provider: "idp", subject: "reauth-2" })).toBe(false);
    expect(await store.reauthenticateWithIdentity({ sessionId: session.id, accountId: holder, provider: "idp", subject: "never-linked" })).toBe(false);

    expect((await store.lookupSession(session.hash))?.reauthAt).toBeNull();
    expect((await identityRows(stranger))[0]?.last_used_at).toBeNull();
  });

  it("accepts the identity for no session of another account", async () => {
    const holder = await account();
    const stranger = await account();
    await link(holder, "idp", "reauth-3");
    const theirSession = await fullSession(stranger);

    expect(await store.reauthenticateWithIdentity({ sessionId: theirSession.id, accountId: holder, provider: "idp", subject: "reauth-3" })).toBe(false);

    expect((await store.lookupSession(theirSession.hash))?.reauthAt).toBeNull();
    expect((await identityRows(holder))[0]?.last_used_at).toBeNull();
  });

  it("accepts a disabled account's identity for nothing, and a session that does not exist", async () => {
    const disabled = await account({ disabled: true });
    await link(disabled, "idp", "reauth-4");
    expect(await store.reauthenticateWithIdentity({ sessionId: freshId(), accountId: disabled, provider: "idp", subject: "reauth-4" })).toBe(false);
    const holder = await account();
    await link(holder, "idp", "reauth-5");
    expect(await store.reauthenticateWithIdentity({ sessionId: freshId(), accountId: holder, provider: "idp", subject: "reauth-5" })).toBe(false);
    expect((await identityRows(holder))[0]?.last_used_at).toBeNull();
  });
});

describe("setting a first password", () => {
  it("stores it for an account without one, keeps the signing session under its new token and refuses the others", async () => {
    const holder = await account({ noPassword: true });
    const current = await fullSession(holder);
    const other = await fullSession(holder);
    const { hash: newTokenHash } = freshToken();

    expect(await store.changePassword({ accountId: holder, sessionId: current.id, passwordHash: HASH, initial: true, newTokenHash })).toBe(true);

    expect(await store.passwordHashOf(holder)).toBe(HASH);
    expect((await store.lookupSession(newTokenHash))?.sessionId).toBe(current.id);
    expect(await store.lookupSession(other.hash)).toBeUndefined();
  });

  it("never replaces a password: the change is refused whole, with the old password, the sessions and the token as they were", async () => {
    const holder = await account();
    const before = await store.passwordHashOf(holder);
    const current = await fullSession(holder);
    const other = await fullSession(holder);
    const { hash: newTokenHash } = freshToken();

    expect(await store.changePassword({ accountId: holder, sessionId: current.id, passwordHash: HASH, initial: true, newTokenHash })).toBe(false);

    expect(await store.passwordHashOf(holder)).toBe(before);
    expect((await store.lookupSession(current.hash))?.sessionId).toBe(current.id);
    expect((await store.lookupSession(other.hash))?.sessionId).toBe(other.id);
    expect(await store.lookupSession(newTokenHash)).toBeUndefined();
  });

  it("sets one password when two first passwords arrive together", async () => {
    const holder = await account({ noPassword: true });
    const one = await fullSession(holder);
    const two = await fullSession(holder);
    const outcomes = await Promise.all(
      [one, two].map((session) => store.changePassword({ accountId: holder, sessionId: session.id, passwordHash: HASH, initial: true, newTokenHash: freshToken().hash })),
    );
    expect(outcomes.toSorted()).toEqual([false, true]);
  });
});
