import { describe, expect, it } from "vitest";
import {
  ALL_DEPLOY_TARGETS,
  applyProductionVersionGate,
  createEmptyDeployTargets,
  detectDeployTargets,
  deriveSyncServices,
  extractAffectedPackages,
  formatGithubOutputs,
  semverLt,
} from "./detect-deploy-targets.mjs";

describe("detectDeployTargets", () => {
  it("deploys marketing only for a marketing-only diff", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: ["@slugbase/marketing"],
      changedPaths: ["packages/marketing/src/pages/index.astro"],
      packageVersions: {},
      forceFullDeploy: false,
    });

    expect(targets.deploy_marketing).toBe(true);
    expect(targets.deploy_api).toBe(false);
    expect(targets.deploy_web).toBe(false);
    expect(targets.deploy_admin).toBe(false);
    expect(targets.push_ghcr_api).toBe(false);
    expect(targets.push_ghcr_web).toBe(false);
    expect(targets.run_migrate).toBe(false);
    expect(targets.sync_services).toBe("marketing");
  });

  it("fans out shared-types changes to api, web, and marketing", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: ["@slugbase/shared-types"],
      changedPaths: ["packages/shared-types/src/contracts/auth.ts"],
      packageVersions: {},
      forceFullDeploy: false,
    });

    expect(targets.deploy_api).toBe(true);
    expect(targets.deploy_web).toBe(true);
    expect(targets.deploy_marketing).toBe(true);
    expect(targets.push_ghcr_api).toBe(true);
    expect(targets.push_ghcr_web).toBe(true);
    expect(targets.deploy_admin).toBe(false);
    expect(targets.sync_services).toBe("api,web,marketing");
  });

  it("deploys all surfaces for lockfile-only changes", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: ["//"],
      changedPaths: ["pnpm-lock.yaml"],
      packageVersions: {},
      forceFullDeploy: false,
    });

    expect(targets).toMatchObject({
      deploy_api: true,
      deploy_web: true,
      deploy_marketing: true,
      deploy_admin: true,
      run_migrate: true,
      run_migrate_admin: true,
      push_ghcr_api: true,
      push_ghcr_web: true,
      sync_services: "api,web,marketing,admin",
    });
  });

  it("runs backend migrate for migration-only diffs", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: [],
      changedPaths: ["packages/backend/migrations/0006_example.sql"],
      packageVersions: {},
      forceFullDeploy: false,
    });

    expect(targets.deploy_api).toBe(true);
    expect(targets.run_migrate).toBe(true);
    expect(targets.push_ghcr_api).toBe(true);
    expect(targets.deploy_web).toBe(false);
    expect(targets.sync_services).toBe("api");
  });

  it("runs admin migrate for db-admin migration diffs", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: [],
      changedPaths: ["packages/db-admin/migrations/0001_example.sql"],
      packageVersions: {},
      forceFullDeploy: false,
    });

    expect(targets.deploy_admin).toBe(true);
    expect(targets.run_migrate_admin).toBe(true);
    expect(targets.deploy_api).toBe(false);
    expect(targets.sync_services).toBe("admin");
  });

  it("enables all deploy flags when force_full_deploy is true", () => {
    const { targets } = detectDeployTargets({
      environment: "production",
      affectedPackages: [],
      changedPaths: [],
      packageVersions: {},
      forceFullDeploy: true,
    });

    expect(targets).toEqual(ALL_DEPLOY_TARGETS);
  });
});

describe("production version gate", () => {
  it("skips backend production deploy when version is below 1.0.0", () => {
    const { targets, skipReasons } = detectDeployTargets({
      environment: "production",
      affectedPackages: ["@slugbase/backend"],
      changedPaths: [],
      packageVersions: { "@slugbase/backend": "0.1.5" },
      forceFullDeploy: false,
    });

    expect(targets.deploy_api).toBe(false);
    expect(targets.push_ghcr_api).toBe(false);
    expect(skipReasons).toEqual(
      expect.arrayContaining([
        "deploy_api: skipped — @slugbase/backend@0.1.5 < 1.0.0 (production gate)",
        "push_ghcr_api: skipped — @slugbase/backend@0.1.5 < 1.0.0 (production gate)",
      ]),
    );
  });

  it("does not gate staging deploys", () => {
    const { targets } = detectDeployTargets({
      environment: "staging",
      affectedPackages: ["@slugbase/backend"],
      changedPaths: [],
      packageVersions: { "@slugbase/backend": "0.1.5" },
      forceFullDeploy: false,
    });

    expect(targets.deploy_api).toBe(true);
    expect(targets.push_ghcr_api).toBe(true);
  });

  it("allows production deploy at 1.0.0", () => {
    const targets = createEmptyDeployTargets();
    targets.deploy_api = true;
    targets.push_ghcr_api = true;

    const skipReasons = applyProductionVersionGate(
      targets,
      "production",
      { "@slugbase/backend": "1.0.0" },
    );

    expect(targets.deploy_api).toBe(true);
    expect(skipReasons).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("extracts turbo affected package names", () => {
    expect(
      extractAffectedPackages({
        packages: ["@slugbase/marketing", "//"],
      }),
    ).toEqual(["@slugbase/marketing", "//"]);
  });

  it("compares semver values", () => {
    expect(semverLt("0.1.5", "1.0.0")).toBe(true);
    expect(semverLt("1.0.0", "1.0.0")).toBe(false);
    expect(semverLt("1.0.1", "1.0.0")).toBe(false);
  });

  it("derives sync_services from deploy flags", () => {
    const targets = createEmptyDeployTargets();
    targets.deploy_api = true;
    targets.deploy_marketing = true;
    expect(deriveSyncServices(targets)).toBe("api,marketing");
  });

  it("formats GitHub outputs with none for empty sync_services", () => {
    expect(formatGithubOutputs(createEmptyDeployTargets())).toMatchObject({
      deploy_api: "false",
      sync_services: "none",
    });
  });
});
