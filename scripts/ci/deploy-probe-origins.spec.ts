import { describe, expect, it } from "vitest";
import {
  DEPLOY_PROBE_ORIGINS,
  resolveDeployProbeOrigins,
  toDeployPlanOrigins,
} from "./deploy-probe-origins.mjs";

describe("resolveDeployProbeOrigins", () => {
  it("returns canonical staging origins by default", () => {
    expect(resolveDeployProbeOrigins("staging")).toEqual(
      DEPLOY_PROBE_ORIGINS.staging,
    );
  });

  it("returns canonical production origins by default", () => {
    expect(resolveDeployProbeOrigins("production")).toEqual(
      DEPLOY_PROBE_ORIGINS.production,
    );
  });

  it("allows env overrides when set", () => {
    expect(
      resolveDeployProbeOrigins("staging", {
        FRONTEND_ORIGIN: "https://override.example.test",
      }),
    ).toMatchObject({
      FRONTEND_ORIGIN: "https://override.example.test",
      APP_BASE_URL: DEPLOY_PROBE_ORIGINS.staging.APP_BASE_URL,
    });
  });

  it("maps to deploy plan surface origins", () => {
    expect(toDeployPlanOrigins(DEPLOY_PROBE_ORIGINS.production)).toEqual({
      api: "https://api.slugbase.app",
      web: "https://cloud.slugbase.app",
      marketing: "https://slugbase.app",
      admin: "https://admin.slugbase.app",
    });
  });
});
