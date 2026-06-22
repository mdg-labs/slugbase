import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyViteEditionEnv } from "./vite-edition-env.js";

const EDITION_ENV_KEYS = [
  "SLUGBASE_EDITION",
  "NODE_ENV",
  "npm_lifecycle_event",
  "VITE_BILLING_ENABLED",
  "VITE_MAIL_ADMIN_UI",
  "VITE_OIDC_ADMIN_UI",
  "VITE_AI_BYO_CREDENTIAL",
] as const;

function clearEditionEnv(): void {
  for (const key of EDITION_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
}

describe("applyViteEditionEnv", () => {
  beforeEach(() => {
    clearEditionEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearEditionEnv();
  });

  it("applies cloud edition VITE_* presets when SLUGBASE_EDITION=cloud", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLUGBASE_EDITION", "cloud");

    applyViteEditionEnv(process.env);

    expect(process.env.SLUGBASE_EDITION).toBe("cloud");
    expect(process.env.VITE_BILLING_ENABLED).toBe("true");
    expect(process.env.VITE_MAIL_ADMIN_UI).toBe("false");
    expect(process.env.VITE_OIDC_ADMIN_UI).toBe("false");
    expect(process.env.VITE_AI_BYO_CREDENTIAL).toBe("false");
  });

  it("applies ce edition VITE_* presets when SLUGBASE_EDITION=ce", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLUGBASE_EDITION", "ce");

    applyViteEditionEnv(process.env);

    expect(process.env.SLUGBASE_EDITION).toBe("ce");
    expect(process.env.VITE_BILLING_ENABLED).toBe("false");
    expect(process.env.VITE_MAIL_ADMIN_UI).toBe("false");
    expect(process.env.VITE_OIDC_ADMIN_UI).toBe("false");
    expect(process.env.VITE_AI_BYO_CREDENTIAL).toBe("false");
  });

  it("defaults to ce in non-production when SLUGBASE_EDITION is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SLUGBASE_EDITION", "");

    applyViteEditionEnv(process.env);

    expect(process.env.SLUGBASE_EDITION).toBe("ce");
    expect(process.env.VITE_BILLING_ENABLED).toBe("false");
    expect(process.env.VITE_MAIL_ADMIN_UI).toBe("false");
  });

  it("keeps explicit VITE_* overrides that match the edition preset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLUGBASE_EDITION", "ce");
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    vi.stubEnv("VITE_MAIL_ADMIN_UI", "false");
    vi.stubEnv("VITE_OIDC_ADMIN_UI", "false");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "false");

    applyViteEditionEnv(process.env);

    expect(process.env.VITE_MAIL_ADMIN_UI).toBe("false");
  });

  it("rejects conflicting explicit VITE_* values in production builds", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SLUGBASE_EDITION", "ce");
    vi.stubEnv("VITE_MAIL_ADMIN_UI", "false");
    vi.stubEnv("VITE_OIDC_ADMIN_UI", "false");
    vi.stubEnv("VITE_AI_BYO_CREDENTIAL", "false");
    vi.stubEnv("VITE_BILLING_ENABLED", "true");

    expect(() => {
      applyViteEditionEnv(process.env);
    }).toThrow(/Production web build refused.*preset conflict/i);
  });

  it("warns on conflicting explicit VITE_* values in development builds", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SLUGBASE_EDITION", "cloud");
    vi.stubEnv("VITE_BILLING_ENABLED", "false");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      return true;
    });

    applyViteEditionEnv(process.env);

    expect(process.env.VITE_BILLING_ENABLED).toBe("false");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("defaults to ce in production builds when SLUGBASE_EDITION is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("npm_lifecycle_event", "build");
    vi.stubEnv("SLUGBASE_EDITION", "");

    applyViteEditionEnv(process.env);

    expect(process.env.SLUGBASE_EDITION).toBe("ce");
    expect(process.env.VITE_BILLING_ENABLED).toBe("false");
  });
});
