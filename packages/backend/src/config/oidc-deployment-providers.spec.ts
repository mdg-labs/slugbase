import { describe, expect, it } from "vitest";

import {
  parseOidcDeploymentProviders,
  type OidcDeploymentProvider,
} from "./oidc-deployment-providers.js";

const sampleProvider: OidcDeploymentProvider = {
  id: "google",
  name: "Google",
  issuerUrl: "https://accounts.google.com",
  clientId: "google-client-id",
  clientSecret: "google-client-secret",
  scopes: "openid email profile",
  enabled: true,
};

describe("parseOidcDeploymentProviders", () => {
  it("returns undefined when env value is unset or blank", () => {
    expect(parseOidcDeploymentProviders(undefined)).toBeUndefined();
    expect(parseOidcDeploymentProviders("")).toBeUndefined();
    expect(parseOidcDeploymentProviders("   ")).toBeUndefined();
  });

  it("parses a valid provider array", () => {
    const raw = JSON.stringify([sampleProvider]);
    expect(parseOidcDeploymentProviders(raw)).toEqual([sampleProvider]);
  });

  it("accepts an empty array as deployment-config source with no providers", () => {
    expect(parseOidcDeploymentProviders("[]")).toEqual([]);
  });

  it("defaults scopes and enabled when omitted", () => {
    const raw = JSON.stringify([
      {
        id: "github",
        name: "GitHub",
        issuerUrl: "https://github.com",
        clientId: "gh-client",
        clientSecret: "gh-secret",
      },
    ]);

    expect(parseOidcDeploymentProviders(raw)).toEqual([
      {
        id: "github",
        name: "GitHub",
        issuerUrl: "https://github.com",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        scopes: "openid email profile",
        enabled: true,
      },
    ]);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseOidcDeploymentProviders("{not-json")).toThrow(
      /valid JSON array/,
    );
  });

  it("rejects duplicate provider ids", () => {
    const raw = JSON.stringify([
      sampleProvider,
      { ...sampleProvider, name: "Google duplicate" },
    ]);

    expect(() => parseOidcDeploymentProviders(raw)).toThrow(/Duplicate provider id/);
  });

  it("rejects invalid provider id slugs", () => {
    const raw = JSON.stringify([{ ...sampleProvider, id: "bad id!" }]);

    expect(() => parseOidcDeploymentProviders(raw)).toThrow(
      /Invalid OIDC_DEPLOYMENT_PROVIDERS/,
    );
  });
});
