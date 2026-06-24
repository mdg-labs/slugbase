import { describe, expect, it, vi } from "vitest";

import {
  EditionPresetConflictError,
  getEditionPresets,
  parseSlugbaseEdition,
  resolveEnvWithEdition,
  SLUGBASE_EDITION,
  SlugbaseEditionParseError,
} from "./edition-presets.js";

describe("parseSlugbaseEdition", () => {
  it("accepts ce and cloud", () => {
    expect(parseSlugbaseEdition("ce")).toBe(SLUGBASE_EDITION.CE);
    expect(parseSlugbaseEdition("cloud")).toBe(SLUGBASE_EDITION.CLOUD);
  });

  it("rejects aliases and invalid values", () => {
    for (const raw of ["CE", "Cloud", "self-hosted", "hosted", "prod", ""]) {
      expect(() => parseSlugbaseEdition(raw)).toThrow(SlugbaseEditionParseError);
    }
    expect(() => parseSlugbaseEdition(undefined)).toThrow(SlugbaseEditionParseError);
  });
});

describe("getEditionPresets", () => {
  it("returns cloud preset values", () => {
    expect(getEditionPresets(SLUGBASE_EDITION.CLOUD)).toEqual({
      PUBLIC_REGISTRATION: "true",
      EMAIL_VERIFICATION_REQUIRED: "true",
      SERVE_WEB_CLIENT: "false",
      VITE_BILLING_ENABLED: "true",
      VITE_MAIL_ADMIN_UI: "false",
      VITE_OIDC_ADMIN_UI: "false",
      VITE_AI_BYO_CREDENTIAL: "false",
    });
  });

  it("returns ce preset values", () => {
    expect(getEditionPresets(SLUGBASE_EDITION.CE)).toEqual({
      PUBLIC_REGISTRATION: "false",
      EMAIL_VERIFICATION_REQUIRED: "false",
      SERVE_WEB_CLIENT: "true",
      VITE_BILLING_ENABLED: "false",
      VITE_MAIL_ADMIN_UI: "false",
      VITE_OIDC_ADMIN_UI: "false",
      VITE_AI_BYO_CREDENTIAL: "false",
    });
  });
});

describe("resolveEnvWithEdition", () => {
  it("applies presets for unset keys", () => {
    const resolved = resolveEnvWithEdition({
      SLUGBASE_EDITION: "cloud",
      NODE_ENV: "development",
    });

    expect(resolved.edition).toBe(SLUGBASE_EDITION.CLOUD);
    expect(resolved.env.PUBLIC_REGISTRATION).toBe("true");
    expect(resolved.env.SERVE_WEB_CLIENT).toBe("false");
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.warnings).toEqual([]);
  });

  it("preserves explicit overrides that match preset semantics", () => {
    const resolved = resolveEnvWithEdition({
      SLUGBASE_EDITION: "ce",
      NODE_ENV: "test",
      PUBLIC_REGISTRATION: "0",
      SERVE_WEB_CLIENT: "true",
    });

    expect(resolved.env.PUBLIC_REGISTRATION).toBe("0");
    expect(resolved.env.SERVE_WEB_CLIENT).toBe("true");
    expect(resolved.conflicts).toEqual([]);
  });

  it("warns on conflicts in non-production", () => {
    const onWarn = vi.fn();
    const resolved = resolveEnvWithEdition(
      {
        SLUGBASE_EDITION: "cloud",
        NODE_ENV: "development",
        PUBLIC_REGISTRATION: "false",
      },
      { onWarn },
    );

    expect(resolved.conflicts).toEqual([
      {
        key: "PUBLIC_REGISTRATION",
        explicit: "false",
        preset: "true",
      },
    ]);
    expect(resolved.warnings).toHaveLength(1);
    expect(onWarn).toHaveBeenCalledOnce();
    expect(resolved.env.PUBLIC_REGISTRATION).toBe("false");
  });

  it("allows CE SERVE_WEB_CLIENT override for split API topology in production", () => {
    const resolved = resolveEnvWithEdition({
      SLUGBASE_EDITION: "ce",
      NODE_ENV: "production",
      SERVE_WEB_CLIENT: "false",
      SESSION_SECRET: "x".repeat(32),
    });

    expect(resolved.env.SERVE_WEB_CLIENT).toBe("false");
    expect(resolved.conflicts).toEqual([]);
  });

  it("throws on conflicts in production", () => {
    expect(() =>
      resolveEnvWithEdition({
        SLUGBASE_EDITION: "ce",
        NODE_ENV: "production",
        VITE_BILLING_ENABLED: "true",
      }),
    ).toThrow(EditionPresetConflictError);
  });

  it("treats empty preset keys as unset", () => {
    const resolved = resolveEnvWithEdition({
      SLUGBASE_EDITION: "ce",
      NODE_ENV: "test",
      VITE_MAIL_ADMIN_UI: "   ",
    });

    expect(resolved.env.VITE_MAIL_ADMIN_UI).toBe("false");
  });

  it("uses editionRaw option when SLUGBASE_EDITION is absent from rawEnv", () => {
    const resolved = resolveEnvWithEdition(
      { NODE_ENV: "test" },
      { editionRaw: "cloud" },
    );

    expect(resolved.edition).toBe(SLUGBASE_EDITION.CLOUD);
    expect(resolved.env.SLUGBASE_EDITION).toBe("cloud");
    expect(resolved.env.VITE_BILLING_ENABLED).toBe("true");
  });
});
