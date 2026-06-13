import { vi } from "vitest";

/** Env vars read by reportportal-config (real GITHUB_ACTIONS values must not leak in CI). */
export const REPORTPORTAL_CI_ENV_KEYS = [
  "CI",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_WORKFLOW",
] as const;

/** Stub CI-related env empty so tests behave the same locally and on GitHub Actions. */
export function isolateReportPortalCiEnv(): void {
  for (const key of REPORTPORTAL_CI_ENV_KEYS) {
    vi.stubEnv(key, "");
  }
}
