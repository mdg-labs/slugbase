import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

export const UNIT_INCLUDE = ["**/*.test.ts", "**/*.test.tsx"];
export const INTEGRATION_INCLUDE = ["**/*.integration.test.ts"];

const ALWAYS_EXCLUDE = ["**/node_modules/**", "**/dist/**", "**/coverage/**"];

export interface SlugbaseVitestOptions {
  /** Run the unit project in jsdom. For packages that render React (web, ui, email). */
  jsdom?: boolean;
  /** Extra exclude globs for both projects. */
  exclude?: string[];
}

export function defineSlugbaseConfig(options: SlugbaseVitestOptions = {}) {
  const exclude = [...ALWAYS_EXCLUDE, ...(options.exclude ?? [])];

  const unit: TestProjectInlineConfiguration = {
    extends: true,
    test: {
      name: "unit",
      include: UNIT_INCLUDE,
      // `*.integration.test.ts` also matches `*.test.ts`; it belongs to the other project.
      exclude: [...exclude, ...INTEGRATION_INCLUDE],
      environment: options.jsdom === true ? "jsdom" : "node",
    },
  };

  const integration: TestProjectInlineConfiguration = {
    extends: true,
    test: {
      name: "integration",
      include: INTEGRATION_INCLUDE,
      exclude,
      environment: "node",
    },
  };

  return defineConfig({
    test: {
      passWithNoTests: true,
      projects: [unit, integration],
    },
  });
}
