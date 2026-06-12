import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReporterDescription } from "@playwright/test";
import type { ReporterConfig } from "allure-js-commons/sdk/reporter";

export type PlaywrightEdition = "hosted" | "self-hosted";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Playwright `--project` flag when a single edition is selected (e2e.sh passes this). */
export function detectPlaywrightEdition(): PlaywrightEdition | null {
  const args = process.argv;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--project=")) {
      const name = arg.slice("--project=".length);
      return name === "hosted" || name === "self-hosted" ? name : null;
    }

    if (arg === "--project" && i + 1 < args.length) {
      const name = args[i + 1];
      return name === "hosted" || name === "self-hosted" ? name : null;
    }
  }

  return null;
}

export function allureE2eResultsDir(edition: PlaywrightEdition): string {
  return path.join(repoRoot, "allure-results", "e2e", edition);
}

export function allurePlaywrightReporterConfig(
  edition: PlaywrightEdition,
): ReporterConfig {
  return {
    resultsDir: allureE2eResultsDir(edition),
    globalLabels: {
      layer: "e2e",
      edition,
    },
  };
}

/** Allure reporter for Playwright e2e; writes to gitignored allure-results/e2e/<edition>/. */
export function allurePlaywrightReporter(
  edition: PlaywrightEdition,
): ReporterDescription[] {
  return [
    [
      "allure-playwright",
      allurePlaywrightReporterConfig(edition) as Record<string, unknown>,
    ],
  ];
}
