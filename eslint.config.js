import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { vocabularyPlugin } from "./tooling/vocabulary/eslint-plugin.ts";

const TS_FILES = ["**/*.{ts,tsx,mts,cts}"];
const JS_FILES = ["**/*.{js,mjs,cjs}"];

// A suppression directive is allowed only with a description that carries an
// issue reference: "#123" or a link ending in "/issues/123".
const ISSUE_LINK = String.raw`^:?\s.*(#\d+|/issues/\d+)`;

export const ignores = {
  ignores: [
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/.turbo/**",
    "**/*.d.ts",
    "packages/contracts/generated/**",
    "packages/db/migrations/**",
    // Deliberately rule-breaking inputs for the tooling tests, which lint them
    // with this same config and assert the expected failures.
    "tooling/fixtures/**",
  ],
};

export const typescriptRules = [
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: TS_FILES,
  })),
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["vitest.shared.ts"],
          defaultProject: "tooling/tsconfig.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-check": false,
          "ts-expect-error": { descriptionFormat: ISSUE_LINK },
          "ts-ignore": { descriptionFormat: ISSUE_LINK },
          "ts-nocheck": true,
          minimumDescriptionLength: 4,
        },
      ],
    },
  },
];

export const javascriptRules = [
  {
    ...js.configs.recommended,
    files: JS_FILES,
  },
  {
    files: JS_FILES,
    languageOptions: {
      sourceType: "module",
      globals: globals.node,
    },
  },
];

export const projectRules = {
  rules: {
    "no-console": "error",
  },
};

// Product vocabulary (doc 00 section 3): the forbidden words and their
// canonical terms live in tooling/vocabulary/forbidden-words.json.
export const vocabularyRules = {
  files: [...TS_FILES, ...JS_FILES],
  plugins: { slugbase: vocabularyPlugin },
  processor: "slugbase/vocabulary",
  rules: {
    "slugbase/no-forbidden-vocabulary": "error",
    "slugbase/vocabulary-disable-reason": "error",
  },
};

// Package boundaries and import bans (doc 09 section 2.1, doc 01 sections 5.3
// and 10): which package may import which, the I/O and database-driver bans,
// the testing-package restriction and unsanitised HTML. The rules decide by the
// path of the linted file, so one block serves the whole repository. A disable
// comment for no-unsafe-html is accepted only with an issue link; the
// suppression processor of the vocabulary block enforces that.
export const boundaryRules = {
  files: [...TS_FILES, ...JS_FILES],
  plugins: { slugbase: vocabularyPlugin },
  rules: {
    "slugbase/import-boundaries": "error",
    "slugbase/no-raw-io": "error",
    "slugbase/no-unsafe-html": "error",
  },
};

export default [ignores, ...javascriptRules, ...typescriptRules, projectRules, vocabularyRules, boundaryRules];
