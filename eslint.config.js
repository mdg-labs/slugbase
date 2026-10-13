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

// Configuration comes only from the environment, read once by the config module
// and the composition root (doc 01 section 3 rule 5, section 11, D24). Anything
// else receives validated values. The block covers library and app source;
// tests, scripts and development tooling are outside it. packages/db keeps two
// development-tooling exceptions: the test harness and the migration check.
const PROCESS_ENV_MESSAGE =
  "process.env is read only in packages/server/src/config/ and apps/slugbase/src/main.ts; take validated configuration as a parameter (doc 01 section 11, D24).";
const PROCESS_NOT_A_REFERENCE = [
  "MemberExpression[computed=false] > Identifier.property",
  "MemberExpression > Identifier.object",
  ":matches(Property, PropertyDefinition, MethodDefinition, TSPropertySignature, TSMethodSignature, TSAbstractPropertyDefinition)[computed=false] > Identifier.key",
  "TSQualifiedName > Identifier.right",
  ":matches(ImportSpecifier) > Identifier.imported",
  ":matches(ExportSpecifier) > Identifier.exported",
].join(", ");
const PROCESS_MODULE = "/^(node:)?process$/";

const PROCESS_IMPORT_PATHS = ["process", "node:process"].map((name) => ({ name, message: PROCESS_ENV_MESSAGE }));

export const processEnvRules = {
  files: ["packages/*/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}", "apps/*/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
  ignores: [
    "packages/server/src/config/**",
    "apps/slugbase/src/main.ts",
    "packages/db/src/testing.ts",
    "packages/db/src/check/**",
  ],
  rules: {
    "no-restricted-syntax": [
      "error",
      // process.env, process["env"], process[`env`] and process[name]; other
      // properties with a literal name (process.exit, process["on"]) stay allowed.
      {
        selector: "MemberExpression[object.name='process'][computed=false][property.name='env']",
        message: PROCESS_ENV_MESSAGE,
      },
      {
        selector:
          "MemberExpression[object.name='process'][computed=true]:not([property.type='Literal'][property.value!='env'])",
        message: PROCESS_ENV_MESSAGE,
      },
      // The global object reaches process too: globalThis.process.env.
      {
        selector: "MemberExpression[object.name=/^(globalThis|global)$/][property.name='process'][computed=false]",
        message: PROCESS_ENV_MESSAGE,
      },
      {
        selector:
          "MemberExpression[object.name=/^(globalThis|global)$/][computed=true]:not([property.type='Literal'][property.value!='process'])",
        message: PROCESS_ENV_MESSAGE,
      },
      // Aliasing or passing process on (const { env } = process, f(process)) hides the read.
      // A property named process ({ process: 0 }, value.process) is not the global.
      {
        selector: `Identifier[name='process']:not(${PROCESS_NOT_A_REFERENCE})`,
        message: PROCESS_ENV_MESSAGE,
      },
      // The module form: require("node:process"), import("node:process").
      {
        selector: `:matches(CallExpression[callee.name='require'], ImportExpression) > Literal[value=${PROCESS_MODULE}]`,
        message: PROCESS_ENV_MESSAGE,
      },
      {
        selector: `:matches(CallExpression[callee.name='require'], ImportExpression) > TemplateLiteral > TemplateElement[value.cooked=${PROCESS_MODULE}]`,
        message: PROCESS_ENV_MESSAGE,
      },
    ],
    "no-restricted-imports": ["error", { paths: PROCESS_IMPORT_PATHS }],
  },
};

// coss ui is the only component library (doc 03 "coss first, coss only", D13).
// Base UI primitives arrive through the vendored coss components; any other
// component, headless-primitive or toast library is banned from the UI and web
// sources. The block repeats the process-import and process-syntax bans of
// processEnvRules because a later no-restricted-imports or no-restricted-syntax
// entry replaces an earlier one for the same files.
const SECOND_LIBRARY_MESSAGE =
  "coss ui (vendored in @slugbase/ui) is the only component library; add the component with the shadcn CLI from the @coss registry instead (doc 03, D13).";
const SECOND_LIBRARY_GROUPS = [
  "@radix-ui/*",
  "radix-ui",
  "@headlessui/*",
  "@ariakit/*",
  "@ark-ui/*",
  "@react-aria/*",
  "@react-stately/*",
  "@react-spectrum/*",
  "@adobe/react-spectrum",
  "react-aria",
  "react-aria-components",
  "react-stately",
  "@mui/*",
  "@chakra-ui/*",
  "@mantine/*",
  "@nextui-org/*",
  "@heroui/*",
  "@fluentui/*",
  "@blueprintjs/*",
  "@ant-design/*",
  "antd",
  "react-bootstrap",
  "semantic-ui-react",
  "primereact",
  "cmdk",
  "vaul",
  "sonner",
  "react-hot-toast",
  "react-toastify",
  "react-select",
];

// Dynamic import("pkg") bypasses no-restricted-imports, so the same packages are
// matched on ImportExpression, as a string literal or a static template literal.
// A selector regex cannot hold "/", hence \x2f; "pkg/*" bans the scope, "pkg" the
// package and its subpaths.
const escapeForSelector = (name) => name.replace(/[\\^$.*+?()|{}]/g, "\\$&").replaceAll("/", "\\x2f");
const SECOND_LIBRARY_MODULE = `/^(${SECOND_LIBRARY_GROUPS.map((group) =>
  group.endsWith("/*") ? escapeForSelector(group.slice(0, -1)) : `${escapeForSelector(group)}(\\x2f|$)`,
).join("|")})/`;

export const componentLibraryRules = {
  files: ["packages/ui/src/**/*.{ts,tsx,mts,cts}", "packages/web/src/**/*.{ts,tsx,mts,cts}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        paths: PROCESS_IMPORT_PATHS,
        patterns: [{ group: SECOND_LIBRARY_GROUPS, message: SECOND_LIBRARY_MESSAGE }],
      },
    ],
    "no-restricted-syntax": [
      ...processEnvRules.rules["no-restricted-syntax"],
      {
        selector: `ImportExpression > Literal[value=${SECOND_LIBRARY_MODULE}]`,
        message: SECOND_LIBRARY_MESSAGE,
      },
      {
        selector: `ImportExpression > TemplateLiteral > TemplateElement[value.cooked=${SECOND_LIBRARY_MODULE}]`,
        message: SECOND_LIBRARY_MESSAGE,
      },
    ],
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

export default [
  ignores,
  ...javascriptRules,
  ...typescriptRules,
  projectRules,
  processEnvRules,
  componentLibraryRules,
  vocabularyRules,
  boundaryRules,
];
