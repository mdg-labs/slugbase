import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

export const UNIT_INCLUDE = ["**/*.test.ts", "**/*.test.tsx"];
export const INTEGRATION_INCLUDE = ["**/*.integration.test.ts"];

/**
 * Timeout, in milliseconds, for a unit test whose work legitimately takes seconds:
 * importing a whole package entry, starting a Vite dev server, running a Vite
 * build, or rendering the whole app. It is declared on those tests alone
 * (`it(name, { timeout: HEAVY_TEST_TIMEOUT_MS }, fn)`); every other test keeps
 * vitest's default of 5 s, so a hang in an ordinary test still fails fast. The
 * longest of these took 5.9 s on the CI runner while every package's unit tests
 * ran at once (issue 420), so the bound leaves five times that.
 */
export const HEAVY_TEST_TIMEOUT_MS = 30_000;

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
