import { describe, expect, it } from "vitest";

import { parseOidcEnvProviders, type OidcEnvProvider } from "./oidc-env-providers.js";

const googleProvider: OidcEnvProvider = {
  id: "google",
  name: "Google",
  issuerUrl: "https://accounts.google.com",
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  scopes: "openid email profile",
  enabled: true,
};

describe("parseOidcEnvProviders", () => {
  it("returns an empty array when no OIDC env vars are set", () => {
    expect(parseOidcEnvProviders({})).toEqual([]);
  });

  it("discovers a provider from the required OIDC_{SLUG}_* trio", () => {
    const providers = parseOidcEnvProviders({
      OIDC_google_CLIENT_ID: "google-client-id",
      OIDC_google_CLIENT_SECRET: "google-client-secret",
      OIDC_google_ISSUER_URL: "https://accounts.google.com",
      OIDC_google_NAME: "Google",
    });

    expect(providers).toEqual([googleProvider]);
  });

  it("normalizes slug casing in env keys to a lowercase provider id", () => {
    const providers = parseOidcEnvProviders({
      OIDC_Google_CLIENT_ID: "google-client-id",
      OIDC_Google_CLIENT_SECRET: "google-client-secret",
      OIDC_Google_ISSUER_URL: "https://accounts.google.com",
    });

    expect(providers).toEqual([
      {
        ...googleProvider,
        name: "Google",
      },
    ]);
  });

  it("defaults name and scopes when optional fields are omitted", () => {
    const providers = parseOidcEnvProviders({
      OIDC_github_CLIENT_ID: "gh-client",
      OIDC_github_CLIENT_SECRET: "gh-secret",
      OIDC_github_ISSUER_URL: "https://github.com",
    });

    expect(providers).toEqual([
      {
        id: "github",
        name: "Github",
        issuerUrl: "https://github.com",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        scopes: "openid email profile",
        enabled: true,
      },
    ]);
  });

  it("includes disabled providers in the parsed list", () => {
    const providers = parseOidcEnvProviders({
      OIDC_google_CLIENT_ID: "google-client-id",
      OIDC_google_CLIENT_SECRET: "google-client-secret",
      OIDC_google_ISSUER_URL: "https://accounts.google.com",
      OIDC_google_ENABLED: "false",
    });

    expect(providers).toEqual([{ ...googleProvider, enabled: false }]);
  });

  it("ignores optional metadata when the required trio is absent", () => {
    expect(
      parseOidcEnvProviders({
        OIDC_google_NAME: "Google",
        OIDC_google_ENABLED: "true",
      }),
    ).toEqual([]);
  });

  it("rejects a partially configured provider", () => {
    expect(() =>
      parseOidcEnvProviders({
        OIDC_google_CLIENT_ID: "google-client-id",
        OIDC_google_ISSUER_URL: "https://accounts.google.com",
      }),
    ).toThrow(/missing required env var\(s\).*CLIENT_SECRET/);
  });

  it("rejects invalid issuer URLs", () => {
    expect(() =>
      parseOidcEnvProviders({
        OIDC_google_CLIENT_ID: "google-client-id",
        OIDC_google_CLIENT_SECRET: "google-client-secret",
        OIDC_google_ISSUER_URL: "not-a-url",
      }),
    ).toThrow(/Invalid OIDC env providers/);
  });

  it("ignores env keys whose slug prefix is invalid", () => {
    expect(
      parseOidcEnvProviders({
        "OIDC_-bad_CLIENT_ID": "client",
        "OIDC_-bad_CLIENT_SECRET": "secret",
        "OIDC_-bad_ISSUER_URL": "https://idp.example.com",
      }),
    ).toEqual([]);
  });
});
