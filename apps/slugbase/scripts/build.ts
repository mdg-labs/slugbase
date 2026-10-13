// `pnpm --filter slugbase build` (doc 09 section 2.1): one directory, `dist/`,
// holding the server bundle (main.js), the hashed web assets (web/) and
// build-info.json, in the layout src/main.ts reads. The image copies it as it is.
//
// node scripts/build.ts [outDir]   (default: dist, next to this app's package.json)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "vite";
import { renderBuildInfo, sourceCommit } from "./build-info.ts";

const APP = resolve(import.meta.dirname, "..");
const outDir = resolve(APP, process.argv[2] ?? "dist");
const require = createRequire(import.meta.url);

const { version } = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string };
// Read before anything is deleted, so a build that cannot tell its revision leaves the last output alone.
const commit = sourceCommit(process.env, APP);

// A stale file from an earlier build must not ship next to the new one.
rmSync(outDir, { recursive: true, force: true });

const tsc = join(dirname(require.resolve("typescript/package.json")), "lib", "tsc.js");
const compiled = spawnSync(process.execPath, [tsc, "-p", join(APP, "tsconfig.build.json"), "--outDir", outDir], {
  cwd: APP,
  stdio: "inherit",
});
if (compiled.status !== 0) {
  throw new Error("the server bundle did not compile");
}

await build({ configFile: join(APP, "vite.config.ts"), build: { outDir: join(outDir, "web"), emptyOutDir: true } });

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "build-info.json"), `${JSON.stringify(renderBuildInfo({ version, commit, now: new Date() }), null, 2)}\n`);
