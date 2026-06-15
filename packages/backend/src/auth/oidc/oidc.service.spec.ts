import { describe, expect, it, vi, beforeEach, afterEach, type MockedObject } from "vitest";
import { calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from "openid-client";

import type { AccountRecord } from "../../accounts/account.types.js";
import type { AccountsService, CreateOidcAccountDto } from "../../accounts/accounts.service.js";
import type { ConfigService } from "../../config/config.service.js";
import type { DbService } from "../../db/db.service.js";
import type { CryptoService } from "@slugbase/shared-types";
import { OidcRepository } from "./oidc.repository.js";
import { OidcService } from "./oidc.service.js";
import type { OidcFlowState, OidcProviderRecord, CreateOidcAccountData } from "./oidc.types.js";

vi.mock("openid-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("openid-client")>();
  return {
    ...original,
    discovery: vi.fn(),
    authorizationCodeGrant: vi.fn(),
  };
});

const MOCK_EMAIL = "user@example.com";
const MOCK_SUBJECT = "oidc-subject-001";

const FLOW_STATE: OidcFlowState = {
  state: "state-1",
  nonce: "nonce-1",
  codeVerifier: "verifier-1",
  providerId: "provider-1",
};

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: "existing-user-1",
    email: MOCK_EMAIL,
    name: "Existing User",
    passwordHash: "hash",
    language: "en",
    theme: "auto",
    accentColor: null,
    defaultBookmarkView: "grid",
    pendingEmail: null,
    isInstanceAdmin: false,
    mfaState: "not_enrolled",
    mfaTotpSecretEncrypted: null,
    aiOptOut: false,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeProvider(): OidcProviderRecord {
  return {
    id: "provider-1",
    name: "Test IdP",
    issuerUrl: "https://idp.example.com",
    clientId: "client-id",
    clientSecretEncrypted: "encrypted",
    scopes: "openid email profile",
    enabled: true,
    createdAt: new Date(),
  };
}

async function buildOidcServiceForCallback(opts: {
  existingAccount?: AccountRecord | null;
  emailVerifiedClaim?: boolean | string;
}) {
  const { authorizationCodeGrant, discovery } = await import("openid-client");

  vi.mocked(discovery).mockResolvedValue({} as never);
  vi.mocked(authorizationCodeGrant).mockResolvedValue({
    claims: () => ({
      sub: MOCK_SUBJECT,
      email: MOCK_EMAIL,
      email_verified: opts.emailVerifiedClaim ?? false,
      name: "OIDC User",
    }),
  } as never);

  const accounts = {
    findByEmail: vi.fn().mockResolvedValue(opts.existingAccount ?? null),
    createOidcAccount: vi.fn().mockImplementation((dto: CreateOidcAccountDto) =>
      Promise.resolve(
        makeAccount({
          id: "new-oidc-user",
          email: dto.email,
          name: dto.name,
          emailVerified: dto.emailVerified,
        }),
      ),
    ),
    markEmailVerified: vi.fn().mockResolvedValue(undefined),
  } as unknown as MockedObject<AccountsService>;

  const config = {
    get: vi.fn((key: string) => {
      if (key === "APP_BASE_URL") return "https://app.example.com";
      return undefined;
    }),
  } as unknown as MockedObject<ConfigService>;

  const crypto = {
    decrypt: vi.fn().mockReturnValue("client-secret"),
    encrypt: vi.fn(),
  } as unknown as MockedObject<CryptoService>;

  const db = {
    getOrm: vi.fn().mockReturnValue({}),
  } as unknown as MockedObject<DbService>;

  vi.spyOn(OidcRepository.prototype, "findAccountByProviderAndSubject").mockResolvedValue(null);
  vi.spyOn(OidcRepository.prototype, "findProviderById").mockResolvedValue(makeProvider());
  const createOidcLink = vi
    .spyOn(OidcRepository.prototype, "createAccount")
    .mockImplementation((data: CreateOidcAccountData) =>
      Promise.resolve({
        id: "oidc-link-1",
        userId: data.userId,
        providerId: data.providerId,
        subject: data.subject,
        createdAt: new Date(),
      }),
    );

  const service = new OidcService(db, config, crypto, accounts);

  return { service, accounts, createOidcLink };
}

describe("OidcService.handleCallback — email auto-link gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-links to an existing account when IdP email_verified is true", async () => {
    const existing = makeAccount({ emailVerified: false });
    const { service, accounts, createOidcLink } = await buildOidcServiceForCallback({
      existingAccount: existing,
      emailVerifiedClaim: true,
    });

    const userId = await service.handleCallback(
      "provider-1",
      FLOW_STATE,
      "https://app.example.com/auth/oidc/provider-1/callback?code=x&state=state-1",
    );

    expect(userId).toBe(existing.id);
    expect(accounts.findByEmail).toHaveBeenCalledWith(MOCK_EMAIL);
    expect(accounts.markEmailVerified).toHaveBeenCalledWith(existing.id);
    expect(accounts.createOidcAccount).not.toHaveBeenCalled();
    expect(createOidcLink).toHaveBeenCalledWith({
      userId: existing.id,
      providerId: "provider-1",
      subject: MOCK_SUBJECT,
    });
  });

  it("accepts email_verified as the string \"true\" from the IdP", async () => {
    const existing = makeAccount();
    const { service, accounts } = await buildOidcServiceForCallback({
      existingAccount: existing,
      emailVerifiedClaim: "true",
    });

    const userId = await service.handleCallback(
      "provider-1",
      FLOW_STATE,
      "https://app.example.com/auth/oidc/provider-1/callback?code=x&state=state-1",
    );

    expect(userId).toBe(existing.id);
    expect(accounts.createOidcAccount).not.toHaveBeenCalled();
  });

  it("does not auto-link when IdP email_verified is false and an account already exists", async () => {
    const existing = makeAccount();
    const { service, accounts, createOidcLink } = await buildOidcServiceForCallback({
      existingAccount: existing,
      emailVerifiedClaim: false,
    });

    const userId = await service.handleCallback(
      "provider-1",
      FLOW_STATE,
      "https://app.example.com/auth/oidc/provider-1/callback?code=x&state=state-1",
    );

    expect(userId).toBe("new-oidc-user");
    expect(userId).not.toBe(existing.id);
    expect(accounts.markEmailVerified).not.toHaveBeenCalled();
    expect(accounts.createOidcAccount).toHaveBeenCalledWith({
      email: `${MOCK_SUBJECT}@oidc.local`,
      name: "OIDC User",
      emailVerified: false,
    });
    expect(createOidcLink).toHaveBeenCalledWith({
      userId: "new-oidc-user",
      providerId: "provider-1",
      subject: MOCK_SUBJECT,
    });
  });
});

describe("OIDC state / nonce generation uniqueness", () => {
  it("generates unique state values across multiple calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomState()));
    expect(values.size).toBe(50);
  });

  it("generates state values with sufficient entropy (>= 32 chars base64url)", () => {
    const state = randomState();
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it("generates unique nonce values across multiple calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => randomNonce()));
    expect(values.size).toBe(50);
  });

  it("generates nonce values with sufficient entropy (>= 32 chars base64url)", () => {
    const nonce = randomNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(32);
  });

  it("state and nonce are different values", () => {
    const state = randomState();
    const nonce = randomNonce();
    expect(state).not.toBe(nonce);
  });
});

describe("OIDC PKCE S256 verifier/challenge pair", () => {
  it("generates a unique code_verifier each call", () => {
    const verifiers: string[] = [];
    for (let i = 0; i < 20; i++) {
      verifiers.push(randomPKCECodeVerifier());
    }
    const unique = new Set(verifiers);
    expect(unique.size).toBe(20);
  });

  it("code_verifier meets RFC 7636 length requirement (43–128 chars)", () => {
    const verifier = randomPKCECodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("code_verifier contains only unreserved characters (RFC 7636)", () => {
    const verifier = randomPKCECodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("calculates a deterministic code_challenge from a given verifier", async () => {
    const verifier = randomPKCECodeVerifier();
    const challenge1 = await calculatePKCECodeChallenge(verifier);
    const challenge2 = await calculatePKCECodeChallenge(verifier);
    expect(challenge1).toBe(challenge2);
  });

  it("different verifiers produce different challenges", async () => {
    const v1 = randomPKCECodeVerifier();
    const v2 = randomPKCECodeVerifier();
    const [c1, c2] = await Promise.all([
      calculatePKCECodeChallenge(v1),
      calculatePKCECodeChallenge(v2),
    ]);
    expect(c1).not.toBe(c2);
  });

  it("code_challenge is base64url-encoded SHA-256 (43 chars without padding)", async () => {
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    // Base64url-encoded SHA-256 (32 bytes) without padding = 43 chars
    expect(challenge.length).toBe(43);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
