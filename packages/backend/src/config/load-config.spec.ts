import { describe, expect, it, vi } from "vitest";

import { SLUGBASE_EDITION } from "@slugbase/shared-types";

import {
  productionEnvWithoutSessionSecret,
  validTestEnv,
} from "../test-utils/test-env.js";
import { loadAppConfig } from "./load-config.js";

describe("loadAppConfig", () => {
  it("applies cloud edition presets when SLUGBASE_EDITION=cloud", () => {
    const config = loadAppConfig({
      ...validTestEnv,
      SLUGBASE_EDITION: "cloud",
      SERVE_WEB_CLIENT: undefined,
      PUBLIC_REGISTRATION: undefined,
    });

    expect(config.edition).toBe(SLUGBASE_EDITION.CLOUD);
    expect(config.SERVE_WEB_CLIENT).toBe(false);
    expect(config.PUBLIC_REGISTRATION).toBe(true);
    expect(config.EMAIL_VERIFICATION_REQUIRED).toBe(true);
  });

  it("applies ce edition presets when SLUGBASE_EDITION=ce", () => {
    const config = loadAppConfig({
      ...validTestEnv,
      SLUGBASE_EDITION: "ce",
      SERVE_WEB_CLIENT: undefined,
      PUBLIC_REGISTRATION: undefined,
      WEB_CLIENT_SERVER_BUILD: "/tmp/web-build",
    });

    expect(config.edition).toBe(SLUGBASE_EDITION.CE);
    expect(config.SERVE_WEB_CLIENT).toBe(true);
    expect(config.PUBLIC_REGISTRATION).toBe(false);
    expect(config.EMAIL_VERIFICATION_REQUIRED).toBe(false);
  });

  it("defaults to ce in non-production when SLUGBASE_EDITION is unset", () => {
    const config = loadAppConfig({
      ...validTestEnv,
      SLUGBASE_EDITION: undefined,
      SERVE_WEB_CLIENT: undefined,
      WEB_CLIENT_SERVER_BUILD: "/tmp/web-build",
    });

    expect(config.edition).toBe(SLUGBASE_EDITION.CE);
    expect(config.SERVE_WEB_CLIENT).toBe(true);
  });

  it("honors explicit overrides that conflict with presets in non-production", () => {
    const onWarn = vi.spyOn(console, "error").mockImplementation(() => {});
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const config = loadAppConfig({
      ...validTestEnv,
      SLUGBASE_EDITION: "cloud",
      PUBLIC_REGISTRATION: "false",
    });

    expect(config.edition).toBe(SLUGBASE_EDITION.CLOUD);
    expect(config.PUBLIC_REGISTRATION).toBe(false);
    expect(stderrSpy).toHaveBeenCalled();

    stderrSpy.mockRestore();
    onWarn.mockRestore();
  });

  it("rejects preset conflicts in production", () => {
    expect(() =>
      loadAppConfig({
        ...validTestEnv,
        NODE_ENV: "production",
        SLUGBASE_EDITION: "ce",
        VITE_BILLING_ENABLED: "true",
      }),
    ).toThrow(/Production startup refused/);
  });

  it("rejects missing SLUGBASE_EDITION in production", () => {
    expect(() =>
      loadAppConfig({
        ...validTestEnv,
        NODE_ENV: "production",
        SLUGBASE_EDITION: undefined,
      }),
    ).toThrow(/Production startup refused/);
  });

  it("rejects invalid SLUGBASE_EDITION at startup", () => {
    expect(() =>
      loadAppConfig({
        ...validTestEnv,
        SLUGBASE_EDITION: "hosted",
      }),
    ).toThrow(/Invalid SLUGBASE_EDITION/);
  });

  it("throws when SESSION_SECRET is missing in production mode", () => {
    expect(() => loadAppConfig(productionEnvWithoutSessionSecret())).toThrow(
      /Production startup refused/,
    );
  });
});
