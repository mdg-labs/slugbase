import base from "../eslint.config.js";

export default [
  // Written by Playwright into the directory it is run from.
  { ignores: ["test-results/**", "playwright-report/**"] },
  ...base,
];
