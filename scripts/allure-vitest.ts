import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReporterConfig } from "allure-js-commons/sdk/reporter";

export type AllureLayer = "unit" | "integration";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function allureResultsDir(
  layer: AllureLayer,
  packageName: string,
): string {
  return path.join(repoRoot, "allure-results", layer, packageName);
}

export function allureReporterConfig(
  layer: AllureLayer,
  packageName: string,
): ReporterConfig {
  return {
    resultsDir: allureResultsDir(layer, packageName),
    globalLabels: {
      layer,
      edition: "hosted",
    },
  };
}

type AllureReporterEntry = [
  "allure-vitest/reporter",
  Record<string, unknown>,
];

/** Allure reporter for Vitest; always writes to gitignored allure-results/. */
export function allureReporters(
  layer: AllureLayer,
  packageName: string,
): AllureReporterEntry[] {
  return [
    [
      "allure-vitest/reporter",
      allureReporterConfig(layer, packageName) as Record<string, unknown>,
    ],
  ];
}
