import base from "../../eslint.config.js";

export default [
  // Written by `tsr generate` from src/routes; it carries its own disable header and is regenerated, never edited.
  { ignores: ["src/routeTree.gen.ts"] },
  ...base,
];
