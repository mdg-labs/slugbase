import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeIdentity, FakeIdentityError } from "../src/index.ts";

const ISSUER = "https://idp.example.test";
const REDIRECT = "https://app.example.test/api/v1/auth/oidc/idp/callback";
const VERIFIER = "v".repeat(43);

function fake(now = 1_700_000_000_000): FakeIdentity {
  return new FakeIdentity({ providers: [{ id: "idp", displayName: "Example IdP", issuer: ISSUER, clientId: "client-1" }], now: () => now });
}

async function authorize(identity: FakeIdentity, state = "state-1"): Promise<string> {
  const { authorizationUrl } = await identity.begin({
    providerId: "idp",
    redirectUri: REDIRECT,
    state,
    nonce: "nonce-1",
    codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
  });
  return authorizationUrl;
}

function codeOf(callback: string): string {
  return new URL(callback).searchParams.get("code") ?? "";
}

function complete(identity: FakeIdentity, code: string, overrides: Partial<Parameters<FakeIdentity["complete"]>[0]> = {}) {
  return identity.complete({ providerId: "idp", redirectUri: REDIRECT, code, nonce: "nonce-1", codeVerifier: VERIFIER, ...overrides });
}

describe("FakeIdentity", () => {
  it("lists its providers and starts a handshake with the S256 challenge, the state and the nonce", async () => {
    const identity = fake();
    expect(await identity.listProviders()).toEqual([{ id: "idp", displayName: "Example IdP" }]);
    const url = new URL(await authorize(identity));
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-1",
      redirect_uri: REDIRECT,
      state: "state-1",
      nonce: "nonce-1",
      code_challenge_method: "S256",
    });
  });

  it("returns the claims of an approved sign-in and sends the browser back with the code and the state", async () => {
    const identity = fake();
    const callback = new URL(identity.approve(await authorize(identity), { subject: "sub-1", email: "a@example.test", emailVerified: true, displayName: "A" }));
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state-1");
    expect(await complete(identity, codeOf(callback.href))).toEqual({
      providerId: "idp",
      subject: "sub-1",
      email: "a@example.test",
      emailVerified: true,
      displayName: "A",
    });
  });

  it("does not call an address verified that the grant does not, and gives no address when there is none", async () => {
    const identity = fake();
    const unverified = await complete(identity, codeOf(identity.approve(await authorize(identity), { subject: "s", email: "a@example.test" })));
    expect(unverified).toMatchObject({ email: "a@example.test", emailVerified: false });
    const none = await complete(identity, codeOf(identity.approve(await authorize(identity, "state-2"), { subject: "s", emailVerified: true })));
    expect(none).toMatchObject({ email: "", emailVerified: false });
  });

  it.each([
    ["a tampered nonce", { nonce: "another-request" }],
    ["another audience", { audience: "another-client" }],
    ["another issuer", { issuer: "https://other.example.test" }],
    ["an expired token", { expiresInSeconds: -1 }],
  ])("refuses %s as an invalid token", async (_name, fault) => {
    const identity = fake();
    const code = codeOf(identity.approve(await authorize(identity), { subject: "sub-1", ...fault }));
    await expect(complete(identity, code)).rejects.toMatchObject({ name: "IdentityError", reason: "invalid_token" });
  });

  it("refuses a nonce the caller did not send, a wrong verifier and another redirect address as a failed exchange", async () => {
    const identity = fake();
    for (const overrides of [{ nonce: "other" }, { codeVerifier: "w".repeat(43) }, { redirectUri: "https://evil.example/callback" }]) {
      const code = codeOf(identity.approve(await authorize(identity), { subject: "sub-1" }));
      await expect(complete(identity, code, overrides)).rejects.toMatchObject({ reason: overrides.nonce === undefined ? "exchange_failed" : "invalid_token" });
    }
  });

  it("accepts a code once, whatever the first exchange did", async () => {
    const identity = fake();
    const code = codeOf(identity.approve(await authorize(identity), { subject: "sub-1" }));
    await expect(complete(identity, code, { codeVerifier: "w".repeat(43) })).rejects.toBeInstanceOf(FakeIdentityError);
    await expect(complete(identity, code)).rejects.toMatchObject({ reason: "exchange_failed" });
  });

  it("refuses an unknown code and an unknown provider", async () => {
    const identity = fake();
    await expect(complete(identity, "unknown")).rejects.toMatchObject({ reason: "exchange_failed" });
    await expect(complete(identity, "unknown", { providerId: "other" })).rejects.toMatchObject({ reason: "provider_unavailable" });
    await expect(identity.begin({ providerId: "other", redirectUri: REDIRECT, state: "s", nonce: "n", codeChallenge: "c" })).rejects.toMatchObject({ reason: "provider_unavailable" });
  });

  it("asks for the credentials again only for a re-authentication, as the adapter does", async () => {
    const identity = fake();
    const request = { providerId: "idp", redirectUri: REDIRECT, state: "s", nonce: "n", codeChallenge: "c" };
    expect(new URL((await identity.begin(request)).authorizationUrl).searchParams.has("prompt")).toBe(false);
    expect(new URL((await identity.begin({ ...request, reauthenticate: true })).authorizationUrl).searchParams.get("prompt")).toBe("login");
  });

  it("will not approve a request it did not see", () => {
    expect(() => fake().approve(`${ISSUER}/authorize?state=unknown`, { subject: "s" })).toThrow("not made by this FakeIdentity");
  });
});
