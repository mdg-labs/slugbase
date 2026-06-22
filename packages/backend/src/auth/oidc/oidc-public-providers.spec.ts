import { describe, expect, it } from "vitest";

import { toPublicOidcLoginProviders } from "./oidc-public-providers.js";

describe("toPublicOidcLoginProviders", () => {
  it("returns only enabled providers with id and name", () => {
    const result = toPublicOidcLoginProviders([
      {
        id: "google",
        name: "Google",
        issuerUrl: "https://accounts.google.com",
        clientId: "google-client",
        clientSecret: "secret",
        scopes: "openid email profile",
        enabled: true,
      },
      {
        id: "disabled",
        name: "Disabled",
        issuerUrl: "https://disabled.example.com",
        clientId: "disabled-client",
        clientSecret: "secret",
        scopes: "openid email profile",
        enabled: false,
      },
    ]);

    expect(result).toEqual([{ id: "google", name: "Google" }]);
    expect(result[0]).not.toHaveProperty("issuerUrl");
    expect(result[0]).not.toHaveProperty("clientId");
  });
});
