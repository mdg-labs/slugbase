import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { renderClientTypes } from "./client-types.ts";

interface Options {
  operations: string;
  outDir: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    operations: resolve(import.meta.dirname, "../src/operations/index.ts"),
    outDir: resolve(import.meta.dirname, "../generated"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--operations" && flag !== "--out-dir") || value === undefined) {
      throw new Error("usage: api-gen.ts [--operations <module exporting operations>] [--out-dir <directory>]");
    }
    options[flag === "--operations" ? "operations" : "outDir"] = resolve(value);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = (await import(pathToFileURL(options.operations).href)) as { operations?: unknown };
  if (!Array.isArray(loaded.operations)) {
    throw new Error(`${options.operations} does not export an operations array`);
  }
  const openApi = serializeOpenApiDocument(buildOpenApiDocument(loaded.operations as unknown[]));
  const files = { "openapi.json": openApi, "schema.d.ts": await renderClientTypes(openApi) };
  mkdirSync(options.outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(options.outDir, name), text);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`api:gen failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
