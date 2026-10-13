// `pnpm dev:web` starts Vite. `--mock` starts it in the "mock" mode, where the
// service worker answers /api from handlers generated from openapi.json and no
// server or database is needed (doc 08 section 7). Every other argument goes to
// Vite as it is; Vite itself rejects flags it does not know, so the flag is
// turned into a mode here.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { viteArguments } from "./dev-web-arguments.ts";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("vite/package.json");
const manifest = require(manifestPath) as { bin: string | Record<string, string> };
const viteBin = resolve(dirname(manifestPath), typeof manifest.bin === "string" ? manifest.bin : manifest.bin["vite"] ?? "");

const child = spawn(process.execPath, [viteBin, ...viteArguments(process.argv.slice(2))], { stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 130);
});
