import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "error",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.react-router/**",
      "packages/web/build/**",
    ],
  },
  {
    files: ["packages/backend/src/**/*.module.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["**/*.spec.ts", "**/*.e2e-spec.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // @nestjs/throttler v6 lacks an `exports` field, so ESLint's TypeScript
    // project service (NodeNext resolution) cannot resolve its types and treats
    // them as `any`. tsc --noEmit passes cleanly. Disable the affected unsafe
    // rules only for files that directly import from @nestjs/throttler.
    files: [
      "packages/backend/src/auth/rate-limit/**/*.ts",
      "packages/backend/src/app.module.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
    },
  },
  {
    files: [
      "packages/backend/src/auth/api-tokens/api-token.controller.ts",
      "packages/backend/src/auth/csrf/csrf.controller.ts",
      "packages/backend/src/auth/login-logout.controller.ts",
      "packages/backend/src/auth/mfa/mfa.controller.ts",
      "packages/backend/src/auth/registration/registration.controller.ts",
      "packages/backend/src/health/health.controller.ts",
    ],
    rules: {
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
