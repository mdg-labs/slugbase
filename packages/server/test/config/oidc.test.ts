import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/index.ts";
import { productionEnv } from "./support.ts";

const GOOGLE = {
  OIDC_GOOGLE_CLIENT_ID: "client-id-qx80",
  OIDC_GOOGLE_CLIENT_SECRET: "client-secret-qx81",
  OIDC_GOOGLE_ISSUER_URL: "https://accounts.example.com",
};

function issues(overrides: Record<string, string | undefined>, type: "server" | "worker" = "server"): { key: string; message: string }[] {
  try {
    loadConfig(type, productionEnv(overrides));
  } catch (error) {
    if (error instanceof ConfigError) {
      return [...error.issues];
    }
    throw error;
  }
  return [];
}

describe("the OIDC_<SLUG>_* keys", () => {
  it("configure no provider when none is set", () => {
    expect(loadConfig("server", productionEnv()).config.OIDC_PROVIDERS).toEqual([]);
  });

  it("parse a provider with the required keys and the defaults of the optional ones", () => {
    expect(loadConfig("server", productionEnv(GOOGLE)).config.OIDC_PROVIDERS).toEqual([
      {
        slug: "google",
        name: "google",
        clientId: "client-id-qx80",
        clientSecret: "client-secret-qx81",
        issuerUrl: "https://accounts.example.com",
        scopes: ["openid", "email", "profile"],
        autoCreate: false,
        allowedDomains: [],
      },
    ]);
  });

  it("parse every optional key", () => {
    const { config } = loadConfig(
      "server",
      productionEnv({
        ...GOOGLE,
        OIDC_GOOGLE_NAME: "  Google Workspace ",
        OIDC_GOOGLE_SCOPES: "openid, email groups",
        OIDC_GOOGLE_ENABLED: "1",
        OIDC_GOOGLE_AUTO_CREATE: "true",
        OIDC_GOOGLE_ALLOWED_DOMAINS: "Example.com, corp.example.org",
      }),
    );
    expect(config.OIDC_PROVIDERS).toEqual([
      {
        slug: "google",
        name: "Google Workspace",
        clientId: "client-id-qx80",
        clientSecret: "client-secret-qx81",
        issuerUrl: "https://accounts.example.com",
        scopes: ["openid", "email", "groups"],
        autoCreate: true,
        allowedDomains: ["example.com", "corp.example.org"],
      },
    ]);
  });

  it("treat empty values as unset", () => {
    const { config } = loadConfig(
      "server",
      productionEnv({ ...GOOGLE, OIDC_GOOGLE_NAME: "", OIDC_GOOGLE_SCOPES: "", OIDC_GOOGLE_ENABLED: "", OIDC_GOOGLE_ALLOWED_DOMAINS: "" }),
    );
    expect(config.OIDC_PROVIDERS).toHaveLength(1);
    expect(config.OIDC_PROVIDERS[0]).toMatchObject({ name: "google", autoCreate: false, allowedDomains: [] });
  });

  it("configure several providers, in slug order, with the slug written lower-case and hyphenated", () => {
    const { config } = loadConfig(
      "server",
      productionEnv({
        ...GOOGLE,
        OIDC_COMPANY_SSO_CLIENT_ID: "id-2",
        OIDC_COMPANY_SSO_CLIENT_SECRET: "secret-2",
        OIDC_COMPANY_SSO_ISSUER_URL: "https://sso.example.com/realms/main",
      }),
    );
    expect(config.OIDC_PROVIDERS.map((provider) => provider.slug)).toEqual(["company-sso", "google"]);
  });

  it("order providers by their public slug, where a hyphen sorts before a letter", () => {
    const { config } = loadConfig(
      "server",
      productionEnv({
        OIDC_COMPANYX_CLIENT_ID: "id-1",
        OIDC_COMPANYX_CLIENT_SECRET: "secret-1",
        OIDC_COMPANYX_ISSUER_URL: "https://x.example.com",
        OIDC_COMPANY_SSO_CLIENT_ID: "id-2",
        OIDC_COMPANY_SSO_CLIENT_SECRET: "secret-2",
        OIDC_COMPANY_SSO_ISSUER_URL: "https://sso.example.com/realms/main",
      }),
    );
    expect(config.OIDC_PROVIDERS.map((provider) => provider.slug)).toEqual(["company-sso", "companyx"]);
  });

  it("leave a disabled provider out, whatever else it lacks", () => {
    const { config } = loadConfig("server", productionEnv({ OIDC_GOOGLE_ENABLED: "false", OIDC_GOOGLE_CLIENT_ID: "only-this" }));
    expect(config.OIDC_PROVIDERS).toEqual([]);
  });

  it("are not part of the worker", () => {
    expect(loadConfig("worker", productionEnv(GOOGLE)).config).not.toHaveProperty("OIDC_PROVIDERS");
    expect(issues({ OIDC_GOOGLE_CLIENT_ID: "only-this" }, "worker")).toEqual([]);
  });

  it.each(["OIDC_GOOGLE_CLIENT_ID", "OIDC_GOOGLE_CLIENT_SECRET", "OIDC_GOOGLE_ISSUER_URL"])(
    "refuse an enabled provider without %s, naming exactly that key",
    (missing) => {
      expect(issues({ ...GOOGLE, [missing]: undefined }).map((issue) => issue.key)).toEqual([missing]);
      expect(issues({ ...GOOGLE, [missing]: "" }).map((issue) => issue.key)).toEqual([missing]);
    },
  );

  it("refuse a provider that has only optional keys, naming the three required ones", () => {
    expect(issues({ OIDC_GOOGLE_NAME: "Google" }).map((issue) => issue.key).sort()).toEqual([
      "OIDC_GOOGLE_CLIENT_ID",
      "OIDC_GOOGLE_CLIENT_SECRET",
      "OIDC_GOOGLE_ISSUER_URL",
    ]);
  });

  it("refuse a missing key outside production as well", () => {
    expect(() =>
      loadConfig("server", { ...productionEnv({ ...GOOGLE, OIDC_GOOGLE_CLIENT_SECRET: undefined }), NODE_ENV: "development" }),
    ).toThrow(/OIDC_GOOGLE_CLIENT_SECRET/);
  });

  it("report each provider's missing keys by that provider's own names", () => {
    const found = issues({ ...GOOGLE, OIDC_CORP_CLIENT_ID: "x", OIDC_CORP_ISSUER_URL: "https://sso.example.com" });
    expect(found.map((issue) => issue.key)).toEqual(["OIDC_CORP_CLIENT_SECRET"]);
  });

  it("require an https issuer in production and allow http elsewhere", () => {
    const http = { ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: "http://localhost:8080/realms/dev" };
    expect(issues(http).map((issue) => issue.key)).toEqual(["OIDC_GOOGLE_ISSUER_URL"]);
    const { config } = loadConfig("server", { ...productionEnv(http), NODE_ENV: "development", APP_ORIGIN: "http://localhost:5173" });
    expect(config.OIDC_PROVIDERS[0]?.issuerUrl).toBe("http://localhost:8080/realms/dev");
  });

  it.each([
    ["OIDC_GOOGLE_ISSUER_URL", "not a url"],
    ["OIDC_GOOGLE_ISSUER_URL", "ftp://accounts.example.com"],
    ["OIDC_GOOGLE_ISSUER_URL", "https://user:pw@accounts.example.com"],
    ["OIDC_GOOGLE_ISSUER_URL", "https://accounts.example.com/?q=1"],
    ["OIDC_GOOGLE_ISSUER_URL", "https://accounts.example.com/#frag"],
    ["OIDC_GOOGLE_NAME", "x".repeat(65)],
    ["OIDC_GOOGLE_NAME", "bad\u0007name"],
    ["OIDC_GOOGLE_SCOPES", "email profile"],
    ["OIDC_GOOGLE_SCOPES", 'openid "quoted"'],
    ["OIDC_GOOGLE_ENABLED", "yes"],
    ["OIDC_GOOGLE_AUTO_CREATE", "maybe"],
    ["OIDC_GOOGLE_ALLOWED_DOMAINS", "not a domain"],
    ["OIDC_GOOGLE_ALLOWED_DOMAINS", "example.com,@example.org"],
  ])("refuse %s=%s without echoing the value", (key, value) => {
    const env = { ...GOOGLE, [key]: value };
    const found = issues(env);
    expect(found.map((issue) => issue.key)).toEqual([key]);
    let thrown: unknown;
    try {
      loadConfig("server", productionEnv(env));
    } catch (error) {
      thrown = error;
    }
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(value);
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(GOOGLE.OIDC_GOOGLE_CLIENT_SECRET);
  });

  it("never put the client secret into a message", () => {
    const thrown = (() => {
      try {
        loadConfig("server", productionEnv({ ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: undefined }));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(GOOGLE.OIDC_GOOGLE_CLIENT_SECRET);
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(GOOGLE.OIDC_GOOGLE_CLIENT_ID);
  });

  it("ignore keys that do not follow the OIDC_<SLUG>_<KEY> form", () => {
    const { config } = loadConfig("server", productionEnv({ OIDC_GOOGLE_CLIENTID: "x", OIDC__CLIENT_ID: "x", oidc_google_client_id: "x" }));
    expect(config.OIDC_PROVIDERS).toEqual([]);
  });
});

// Q120: an operator names, per provider, the host of its issuer when the provider is on a private address.
describe("OIDC_<SLUG>_ALLOWED_PRIVATE_HOST", () => {
  const LAN = { ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: "https://idp.lan:8443/realms/main" };
  const keysOf = (overrides: Record<string, string | undefined>): string[] => issues(overrides).map((issue) => issue.key).sort();

  it("leaves the origins empty when no provider names a host, and does not put the host into the provider", () => {
    const { config } = loadConfig("server", productionEnv(GOOGLE));
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual([]);
    const named = loadConfig("server", productionEnv({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).config;
    expect(named.OIDC_PROVIDERS[0]).not.toHaveProperty("allowedPrivateHost");
  });

  it("yields the origin of the issuer of the provider that names its host, and of no other provider", () => {
    const { config } = loadConfig(
      "server",
      productionEnv({
        ...LAN,
        OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan",
        OIDC_CORP_CLIENT_ID: "id-2",
        OIDC_CORP_CLIENT_SECRET: "secret-2",
        OIDC_CORP_ISSUER_URL: "https://sso.lan/realms/main",
        OIDC_OTHER_CLIENT_ID: "id-3",
        OIDC_OTHER_CLIENT_SECRET: "secret-3",
        OIDC_OTHER_ISSUER_URL: "https://sso.example.com",
        OIDC_OTHER_ALLOWED_PRIVATE_HOST: "sso.example.com",
      }),
    );
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual(["https://idp.lan:8443", "https://sso.example.com"]);
  });

  it("treats an empty value as unset", () => {
    expect(loadConfig("server", productionEnv({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "" })).config.OIDC_PRIVATE_ORIGINS).toEqual([]);
  });

  it("gives a disabled provider no origin", () => {
    const { config } = loadConfig("server", productionEnv({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan", OIDC_GOOGLE_ENABLED: "false" }));
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual([]);
  });

  it("is not part of the worker", () => {
    expect(loadConfig("worker", productionEnv({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).config).not.toHaveProperty("OIDC_PRIVATE_ORIGINS");
  });

  it.each([
    ["a scheme", "https://idp.lan"],
    ["a port", "idp.lan:8443"],
    ["a path", "idp.lan/realms/main"],
    ["userinfo", "user@idp.lan"],
    ["a wildcard", "*.lan"],
    ["a comma", "idp.lan,other.lan"],
    ["a network range", "10.0.0.0/8"],
    ["a space", "idp.lan other.lan"],
    ["a percent escape", "idp%2elan"],
    ["a malformed IPv6 literal", "[::1"],
  ])("refuses a value with %s, naming only that key and no value", (_label, value) => {
    const env = { ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: value };
    expect(issues(env)).toEqual([{ key: "OIDC_GOOGLE_ALLOWED_PRIVATE_HOST", message: expect.not.stringContaining(value) as string }]);
    let thrown: unknown;
    try {
      loadConfig("server", productionEnv(env));
    } catch (error) {
      thrown = error;
    }
    expect(inspect(thrown, { depth: null, showHidden: true })).not.toContain(value);
  });

  it("refuses a host that is not the host of the provider's own issuer, so a changed issuer never keeps an allowance meant for the old host", () => {
    const found = issues({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "other.lan" });
    expect(found).toEqual([{ key: "OIDC_GOOGLE_ALLOWED_PRIVATE_HOST", message: "must be the host of the provider's ISSUER_URL" }]);
    expect(JSON.stringify(found)).not.toContain("other.lan");
    expect(keysOf({ ...LAN, OIDC_GOOGLE_ISSUER_URL: "https://other.lan", OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).toEqual([
      "OIDC_GOOGLE_ALLOWED_PRIVATE_HOST",
    ]);
  });

  it("refuses the host of another provider's issuer", () => {
    const env = {
      ...LAN,
      OIDC_CORP_CLIENT_ID: "id-2",
      OIDC_CORP_CLIENT_SECRET: "secret-2",
      OIDC_CORP_ISSUER_URL: "https://sso.lan",
      OIDC_CORP_ALLOWED_PRIVATE_HOST: "idp.lan",
    };
    expect(keysOf(env)).toEqual(["OIDC_CORP_ALLOWED_PRIVATE_HOST"]);
  });

  it("does not fold a trailing dot: it is another host", () => {
    expect(keysOf({ ...LAN, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan." })).toEqual(["OIDC_GOOGLE_ALLOWED_PRIVATE_HOST"]);
    expect(keysOf({ ...LAN, OIDC_GOOGLE_ISSUER_URL: "https://idp.lan./", OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).toEqual([
      "OIDC_GOOGLE_ALLOWED_PRIVATE_HOST",
    ]);
  });

  it.each([
    ["case", "https://idp.lan", "IDP.Lan", "https://idp.lan"],
    ["the default port", "https://idp.lan:443", "idp.lan", "https://idp.lan"],
    ["an IPv4 notation", "https://0300.168.1.20:8443", "192.168.1.20", "https://192.168.1.20:8443"],
    ["IDNA", "https://bücher.lan", "xn--bcher-kva.lan", "https://xn--bcher-kva.lan"],
    ["an IPv6 literal", "https://[0:0:0:0:0:0:0:1]:8443", "[::1]", "https://[::1]:8443"],
  ])("matches after URL normalisation: %s", (_label, issuer, host, origin) => {
    const { config } = loadConfig("server", productionEnv({ ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: issuer, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: host }));
    expect(config.OIDC_PRIVATE_ORIGINS).toEqual([origin]);
  });

  it("does not relax the https rule of production: an http issuer is still refused there, with or without the host", () => {
    const http = { ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: "http://idp.lan:8080" };
    expect(keysOf(http)).toEqual(["OIDC_GOOGLE_ISSUER_URL"]);
    expect(keysOf({ ...http, OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).toEqual(["OIDC_GOOGLE_ISSUER_URL"]);
  });

  it("names the key when the issuer is also invalid, and reports no origin", () => {
    expect(keysOf({ ...GOOGLE, OIDC_GOOGLE_ISSUER_URL: "not a url", OIDC_GOOGLE_ALLOWED_PRIVATE_HOST: "idp.lan" })).toEqual(["OIDC_GOOGLE_ISSUER_URL"]);
  });
});

// Q121: Microsoft Entra ID's multi-tenant endpoints and its `xms_edov` claim are opt-ins of a provider.
describe("OIDC_<SLUG>_ENTRA_*", () => {
  const ENTRA = {
    OIDC_ENTRA_CLIENT_ID: "client-id-qx96",
    OIDC_ENTRA_CLIENT_SECRET: "client-secret-qx97",
    OIDC_ENTRA_ISSUER_URL: "https://login.microsoftonline.com/common/v2.0",
  };
  const TENANT = "8aa3c2b1-4d5e-4f60-9a7b-0c1d2e3f4a5b";
  const OTHER_TENANT = "11111111-2222-4333-8444-555555555555";
  const keysOf = (overrides: Record<string, string | undefined>): string[] => issues(overrides).map((issue) => issue.key);
  const provider = (overrides: Record<string, string | undefined>) => loadConfig("server", productionEnv(overrides)).config.OIDC_PROVIDERS[0];

  it("leave a provider that sets none of them exactly as it was", () => {
    expect(provider(ENTRA)).toEqual({
      slug: "entra",
      name: "entra",
      clientId: "client-id-qx96",
      clientSecret: "client-secret-qx97",
      issuerUrl: "https://login.microsoftonline.com/common/v2.0",
      scopes: ["openid", "email", "profile"],
      autoCreate: false,
      allowedDomains: [],
    });
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "false", OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "0" })).not.toHaveProperty("entraMultiTenant");
  });

  it("parse every key", () => {
    expect(
      provider({
        ...ENTRA,
        OIDC_ENTRA_ENTRA_MULTI_TENANT: "true",
        OIDC_ENTRA_ENTRA_TENANTS: ` ${TENANT.toUpperCase()}, ${OTHER_TENANT},${TENANT}`,
        OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "1",
      }),
    ).toMatchObject({ entraMultiTenant: true, entraTenants: [TENANT, OTHER_TENANT], entraVerifiedDomain: true });
  });

  it("accept the multi-tenant keys alone and on each of the two templated endpoints, on any host", () => {
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "true" })).toMatchObject({ entraMultiTenant: true });
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "true" })).not.toHaveProperty("entraTenants");
    for (const url of [
      "https://login.microsoftonline.com/organizations/v2.0",
      "https://login.microsoftonline.us/common/v2.0",
      "https://login.partner.microsoftonline.cn/organizations/v2.0",
    ]) {
      expect(provider({ ...ENTRA, OIDC_ENTRA_ISSUER_URL: url, OIDC_ENTRA_ENTRA_MULTI_TENANT: "true" })).toMatchObject({ issuerUrl: url, entraMultiTenant: true });
    }
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "true" })).toMatchObject({ entraVerifiedDomain: true });
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "true" })).not.toHaveProperty("entraMultiTenant");
  });

  it("treat empty values as unset", () => {
    expect(provider({ ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "", OIDC_ENTRA_ENTRA_TENANTS: "", OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "" })).not.toHaveProperty("entraTenants");
  });

  it("make a provider exist like any other key, which then needs its required keys", () => {
    expect(keysOf({ OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN: "true" }).sort()).toEqual(["OIDC_ENTRA_CLIENT_ID", "OIDC_ENTRA_CLIENT_SECRET", "OIDC_ENTRA_ISSUER_URL"]);
  });

  it.each([
    "https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0",
    "https://login.microsoftonline.com/8aa3c2b1-4d5e-4f60-9a7b-0c1d2e3f4a5b/v2.0",
    "https://login.microsoftonline.com/consumers/v2.0",
    "https://login.microsoftonline.com/common/v2.0/",
    "https://login.microsoftonline.com/common",
    "https://login.microsoftonline.com/common/v1.0",
    "https://login.microsoftonline.com/Common/v2.0",
    "https://login.microsoftonline.com/x/common/v2.0",
    "https://login.microsoftonline.com/",
    "https://accounts.example.com",
  ])("refuse ENTRA_MULTI_TENANT with the issuer %s, naming the issuer key and no value", (url) => {
    const env = { ...ENTRA, OIDC_ENTRA_ISSUER_URL: url, OIDC_ENTRA_ENTRA_MULTI_TENANT: "true" };
    expect(issues(env)).toEqual([{ key: "OIDC_ENTRA_ISSUER_URL", message: expect.stringContaining("OIDC_ENTRA_ENTRA_MULTI_TENANT") as string }]);
    expect(inspect(issues(env), { depth: null })).not.toContain(url);
  });

  it("accept those issuers when the multi-tenant rule is off", () => {
    expect(issues({ ...ENTRA, OIDC_ENTRA_ISSUER_URL: `https://login.microsoftonline.com/${TENANT}/v2.0`, OIDC_ENTRA_ENTRA_MULTI_TENANT: "false" })).toEqual([]);
  });

  it.each([undefined, "false", "0"])("refuse ENTRA_TENANTS without ENTRA_MULTI_TENANT (%s)", (flag) => {
    const env = { ...ENTRA, OIDC_ENTRA_ENTRA_TENANTS: TENANT, OIDC_ENTRA_ENTRA_MULTI_TENANT: flag };
    expect(keysOf(env)).toEqual(["OIDC_ENTRA_ENTRA_TENANTS"]);
    expect(inspect(issues(env), { depth: null })).not.toContain(TENANT);
  });

  it.each([
    "contoso.onmicrosoft.com",
    "common",
    `${TENANT},`,
    `${TENANT},not-a-guid`,
    `${TENANT}/`,
    `${TENANT}0`,
    "8aa3c2b1-4d5e-4f60-9a7b",
    `{${TENANT}}`,
    TENANT.replaceAll("-", ""),
  ])("refuse ENTRA_TENANTS holding %s, naming that key and no value", (value) => {
    const env = { ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "true", OIDC_ENTRA_ENTRA_TENANTS: value };
    expect(keysOf(env)).toEqual(["OIDC_ENTRA_ENTRA_TENANTS"]);
    expect(inspect(issues(env), { depth: null })).not.toContain(value);
  });

  it.each(["OIDC_ENTRA_ENTRA_MULTI_TENANT", "OIDC_ENTRA_ENTRA_VERIFIED_DOMAIN"])("refuse a %s that envBoolean does not accept, naming only that key", (key) => {
    for (const value of ["yes", "True", "2", "on"]) {
      expect(keysOf({ ...ENTRA, [key]: value }), value).toEqual([key]);
    }
  });

  it("report a multi-tenant issuer problem only once when the flag is itself refused", () => {
    expect(keysOf({ ...ENTRA, OIDC_ENTRA_ISSUER_URL: "https://accounts.example.com", OIDC_ENTRA_ENTRA_MULTI_TENANT: "yes", OIDC_ENTRA_ENTRA_TENANTS: TENANT })).toEqual([
      "OIDC_ENTRA_ENTRA_MULTI_TENANT",
    ]);
  });

  it("are not part of the worker", () => {
    expect(issues({ ...ENTRA, OIDC_ENTRA_ENTRA_MULTI_TENANT: "yes" }, "worker")).toEqual([]);
  });
});
