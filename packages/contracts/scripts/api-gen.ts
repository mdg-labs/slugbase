import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";

interface Options {
  operations: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    operations: resolve(import.meta.dirname, "../src/operations/index.ts"),
    out: resolve(import.meta.dirname, "../generated/openapi.json"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== "--operations" && flag !== "--out") || value === undefined) {
      throw new Error("usage: api-gen.ts [--operations <module exporting operations>] [--out <file>]");
    }
    options[flag === "--operations" ? "operations" : "out"] = resolve(value);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const loaded = (await import(pathToFileURL(options.operations).href)) as { operations?: unknown };
  if (!Array.isArray(loaded.operations)) {
    throw new Error(`${options.operations} does not export an operations array`);
  }
  const text = serializeOpenApiDocument(buildOpenApiDocument(loaded.operations as unknown[]));
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, text);
}

main().catch((error: unknown) => {
  process.stderr.write(`api:gen failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
