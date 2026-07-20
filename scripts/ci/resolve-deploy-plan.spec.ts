import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_VERSION,
  semverGt,
} from "./probe-version.mjs";
import {
  createEmptyPlan,
  formatGithubOutputs,
  PRODUCTION_MIN_VERSION,
  resolveDeployPlan,
} from "./resolve-deploy-plan.mjs";

describe("resolveDeployPlan", () => {
  const packageVersions = {
    "@slugbase/backend": "1.0.1",
    "@slugbase/web": "1.0.1",
    "@slugbase/marketing": "1.0.1",
    "@slugbase/admin": "1.0.1",
  };

  it("deploys when intended version is greater than live", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ version: "1.0.0" }),
    });

    const { plan, skipReasons } = await resolveDeployPlan({
      environment: "staging",
      deployMode: "auto",
      packageVersions,
      origins: {
        api: "https://api.example.test",
        web: "https://web.example.test",
        marketing: "https://marketing.example.test",
        admin: "https://admin.example.test",
      },
      fetchFn,
    });

    expect(plan.deploy_api).toBe(true);
    expect(plan.deploy_web).toBe(true);
    expect(plan.run_migrate).toBe(true);
    expect(plan.push_ghcr_api).toBe(true);
    expect(plan.push_ghcr_web).toBe(true);
    expect(plan.deploy_marketing).toBe(true);
    expect(plan.deploy_admin).toBe(true);
    expect(skipReasons).toHaveLength(0);
  });

  it("skips surfaces when live matches intended", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ version: "1.0.1" }),
    });

    const { plan, skipReasons } = await resolveDeployPlan({
      environment: "staging",
      deployMode: "auto",
      packageVersions,
      origins: {
        api: "https://api.example.test",
        web: "https://web.example.test",
      },
      fetchFn,
    });

    expect(plan.deploy_api).toBe(false);
    expect(plan.deploy_web).toBe(false);
    expect(skipReasons.some((r) => r.includes("api:"))).toBe(true);
  });

  it("self-heals when live lags intended without new bump", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ version: "1.0.0" }),
    });

    const versions = { ...packageVersions, "@slugbase/backend": "1.0.1" };
    const { plan } = await resolveDeployPlan({
      environment: "staging",
      deployMode: "auto",
      packageVersions: versions,
      origins: { api: "https://api.example.test" },
      fetchFn,
    });

    expect(plan.deploy_api).toBe(true);
    expect(semverGt("1.0.1", "1.0.0")).toBe(true);
  });

  it("bootstraps unreachable live to 0.0.0 and deploys staging marketing", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { plan } = await resolveDeployPlan({
      environment: "staging",
      deployMode: "auto",
      packageVersions: { "@slugbase/marketing": "0.2.0" },
      origins: { marketing: "https://marketing.example.test" },
      fetchFn,
      maxAttempts: 1,
      initialDelayMs: 1,
    });

    expect(plan.deploy_marketing).toBe(true);
  });

  it("manual mode skips live compare", async () => {
    const fetchFn = vi.fn();

    const { plan } = await resolveDeployPlan({
      environment: "staging",
      deployMode: "manual",
      packageVersions: { "@slugbase/web": "0.3.0" },
      origins: { web: "https://web.example.test" },
      fetchFn,
    });

    expect(plan.deploy_web).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("production gate skips packages below 1.0.0", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ version: BOOTSTRAP_VERSION }),
    });

    const { plan, skipReasons } = await resolveDeployPlan({
      environment: "production",
      deployMode: "auto",
      packageVersions: { "@slugbase/marketing": "0.9.9" },
      origins: {
        api: "https://api.example.test",
        web: "https://web.example.test",
        marketing: "https://marketing.example.test",
        admin: "https://admin.example.test",
      },
      fetchFn,
    });

    expect(plan.deploy_marketing).toBe(false);
    expect(
      skipReasons.some((reason) => reason.includes(PRODUCTION_MIN_VERSION)),
    ).toBe(true);
  });

  it("formats GitHub outputs with deployed flags false in plan", () => {
    const plan = createEmptyPlan();
    plan.deploy_api = true;

    expect(formatGithubOutputs(plan)).toMatchObject({
      deploy_api: "true",
      deployed_api: "false",
      deployed_web: "false",
    });
  });
});
