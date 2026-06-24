import { describe, expect, it } from "vitest";
import {
  applyAlreadyDeployedSkip,
  checkProductionDeployNeeded,
  evaluateProductionSurface,
  formatProductionDeployOutputs,
  shaMatches,
} from "./check-production-deploy-needed.mjs";
import { createEmptyDeployTargets } from "./detect-deploy-targets.mjs";

describe("shaMatches", () => {
  it("matches full or short SHAs", () => {
    expect(shaMatches("abc1234567890", "abc1234567890")).toBe(true);
    expect(shaMatches("abc1234", "abc1234567890")).toBe(true);
    expect(shaMatches("abc1234567890", "abc1234")).toBe(true);
    expect(shaMatches("abc1234", "def5678")).toBe(false);
  });
});

describe("evaluateProductionSurface", () => {
  it("skips api below the production minimum version", () => {
    expect(
      evaluateProductionSurface({
        surface: "api",
        packageVersions: { "@slugbase/backend": "0.2.0" },
        deployedState: {},
        releaseSha: "abc1234",
      }),
    ).toEqual({
      needsDeploy: false,
      reason:
        "api: skipped — @slugbase/backend@0.2.0 < 1.0.0 (production gate)",
    });
  });

  it("deploys marketing at 1.0.0 when not yet recorded", () => {
    expect(
      evaluateProductionSurface({
        surface: "marketing",
        packageVersions: { "@slugbase/marketing": "1.0.0" },
        deployedState: {},
        releaseSha: "abc1234",
      }),
    ).toEqual({
      needsDeploy: true,
      reason: "marketing: deploy needed (@slugbase/marketing@1.0.0)",
    });
  });

  it("skips surfaces already at version and SHA", () => {
    expect(
      evaluateProductionSurface({
        surface: "marketing",
        packageVersions: { "@slugbase/marketing": "1.0.0" },
        deployedState: {
          marketing: { version: "1.0.0", sha: "abc1234567890" },
        },
        releaseSha: "abc1234",
      }),
    ).toEqual({
      needsDeploy: false,
      reason: "marketing: skipped — already deployed 1.0.0@abc1234567890",
    });
  });
});

describe("checkProductionDeployNeeded", () => {
  it("deploys marketing at 1.0.0 while api at 0.2.0 stays gated", () => {
    const result = checkProductionDeployNeeded({
      releaseSha: "abc1234",
      deployedStateJson: "{}",
      packageVersions: {
        "@slugbase/backend": "0.2.0",
        "@slugbase/web": "0.1.0",
        "@slugbase/marketing": "1.0.0",
        "@slugbase/admin": "0.1.0",
      },
    });

    expect(result.shouldDeploy).toBe(true);
    expect(result.surfaces).toEqual({
      api: false,
      web: false,
      marketing: true,
      admin: false,
    });
    expect(result.skipReasons).toEqual(
      expect.arrayContaining([
        "api: skipped — @slugbase/backend@0.2.0 < 1.0.0 (production gate)",
        "web: skipped — @slugbase/web@0.1.0 < 1.0.0 (production gate)",
      ]),
    );
    expect(result.log).toEqual(
      expect.arrayContaining([
        "marketing: deploy needed (@slugbase/marketing@1.0.0)",
      ]),
    );
  });

  it("skips a full re-publish when all eligible surfaces are already deployed", () => {
    const result = checkProductionDeployNeeded({
      releaseSha: "abc1234567890",
      deployedStateJson: JSON.stringify({
        marketing: { version: "1.0.0", sha: "abc1234567890" },
      }),
      packageVersions: {
        "@slugbase/backend": "0.2.0",
        "@slugbase/marketing": "1.0.0",
      },
    });

    expect(result.shouldDeploy).toBe(false);
    expect(result.surfaces.marketing).toBe(false);
    expect(result.log).toEqual(
      expect.arrayContaining([
        "All production surfaces already deployed or gated — skipping release deploy",
      ]),
    );
  });

  it("allows partial re-run when only some surfaces are recorded", () => {
    const result = checkProductionDeployNeeded({
      releaseSha: "def5678901234",
      deployedStateJson: JSON.stringify({
        marketing: { version: "1.0.0", sha: "def5678901234" },
      }),
      packageVersions: {
        "@slugbase/marketing": "1.0.0",
        "@slugbase/web": "1.0.0",
      },
    });

    expect(result.shouldDeploy).toBe(true);
    expect(result.surfaces).toMatchObject({
      marketing: false,
      web: true,
    });
  });
});

describe("applyAlreadyDeployedSkip", () => {
  it("clears deploy flags for already-recorded surfaces", () => {
    const targets = createEmptyDeployTargets();
    targets.deploy_marketing = true;
    targets.deploy_api = true;
    targets.run_migrate = true;
    targets.push_ghcr_api = true;

    applyAlreadyDeployedSkip(targets, {
      deployedState: {
        marketing: { version: "1.0.0", sha: "abc1234567890" },
      },
      packageVersions: {
        "@slugbase/marketing": "1.0.0",
        "@slugbase/backend": "1.0.0",
      },
      releaseSha: "abc1234",
    });

    expect(targets.deploy_marketing).toBe(false);
    expect(targets.deploy_api).toBe(true);
    expect(targets.run_migrate).toBe(true);
    expect(targets.push_ghcr_api).toBe(true);
  });
});

describe("formatProductionDeployOutputs", () => {
  it("maps surface needs to GitHub outputs", () => {
    expect(
      formatProductionDeployOutputs({
        api: false,
        web: false,
        marketing: true,
        admin: false,
      }),
    ).toEqual({
      should_deploy: "true",
      deploy_api_needed: "false",
      deploy_web_needed: "false",
      deploy_marketing_needed: "true",
      deploy_admin_needed: "false",
    });
  });
});
