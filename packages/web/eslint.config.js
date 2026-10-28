import base from "../../eslint.config.js";

// ESLint takes the directory of the config file it loads as the base path of every
// block, so the root blocks scoped by repository-relative globs (packages/web/src/**)
// would match nothing from here. Giving them the repository root as base path keeps
// those globs meaningful when this package is linted on its own.
const ROOT_BASE_PATH = "../..";

export default [
  // Written by `tsr generate` from src/routes; it carries its own disable header and is regenerated, never edited.
  { ignores: ["src/routeTree.gen.ts"] },
  ...base.map((block) => ({ ...block, basePath: ROOT_BASE_PATH })),
];
