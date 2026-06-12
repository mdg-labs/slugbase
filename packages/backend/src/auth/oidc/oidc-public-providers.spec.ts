import { describe, expect, it } from "vitest";

import { toPublicOidcLoginProviders } from "./oidc-public-providers.js";
import type { OidcProviderRecord } from "./oidc.types.js";

function makeProvider(overrides: Partial<OidcProviderRecord> = {}): OidcProviderRecord {
  return {
    id: "provider-1",
    name: "Test IdP",
    issuerUrl: "https://idp.example.com",
    clientId: "client-123",
    clientSecretEncrypted: "aes:encrypted-secret",
    scopes: "openid email profile",
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("toPublicOidcLoginProviders", () => {
  it("returns only id and name", () => {
    const result = toPublicOidcLoginProviders([
      makeProvider({ id: "a", name: "Alpha" }),
      makeProvider({ id: "b", name: "Beta" }),
    ]);

    expect(result).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ]);
    expect(result[0]).not.toHaveProperty("issuerUrl");
    expect(result[0]).not.toHaveProperty("clientId");
  });
});
