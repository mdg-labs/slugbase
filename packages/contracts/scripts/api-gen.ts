import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ExportDocumentSchema } from "../src/operations/export.ts";
import { buildOpenApiDocument, serializeOpenApiDocument } from "../src/openapi/generate.ts";
import { renderClientTypes } from "./client-types.ts";

interface Options {
  operations: string;
  outDir: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function sortKeys(node: Json): Json {
  if (Array.isArray(node)) {
    return node.map(sortKeys);
  }
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sortKeys(node[key] ?? null)]));
  }
  return node;
}

/** The JSON Schema (draft 2020-12) of the SlugBase export document, in the committed form: sorted keys, two-space indent, trailing newline. */
function renderExportSchema(): string {
  const generated = z.toJSONSchema(ExportDocumentSchema, { target: "draft-2020-12", io: "output", unrepresentable: "throw" }) as { [key: string]: Json };
  return `${JSON.stringify(sortKeys({ ...generated, title: "SlugBase export" }), null, 2)}\n`;
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
  const files = {
    "openapi.json": openApi,
    "schema.d.ts": await renderClientTypes(openApi),
    "slugbase-export.schema.json": renderExportSchema(),
  };
  mkdirSync(options.outDir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(options.outDir, name), text);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`api:gen failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
