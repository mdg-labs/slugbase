import { readFileSync } from "node:fs";
import { Document, Spectral } from "@stoplight/spectral-core";
import parsers from "@stoplight/spectral-parsers";
import { ruleset } from "../spectral/slugbase.ruleset.ts";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: readonly (string | number)[]): string {
  return `#/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/** Names the operation a finding sits in, from the first three segments of its path. */
function operationOf(document: unknown, path: readonly (string | number)[]): string {
  const [section, route, method] = path;
  if (section !== "paths" || typeof route !== "string" || typeof method !== "string" || !METHODS.includes(method)) {
    return "(no operation)";
  }
  const paths = isRecord(document) ? document["paths"] : undefined;
  const item = isRecord(paths) ? paths[route] : undefined;
  const operation = isRecord(item) ? item[method] : undefined;
  const id = isRecord(operation) ? operation["operationId"] : undefined;
  return `${method.toUpperCase()} ${route} (${typeof id === "string" && id !== "" ? id : "no operationId"})`;
}

/**
 * Lints the OpenAPI document at `file` with the SlugBase ruleset and returns one line per finding
 * (rule, operation, path, message); an empty list means the document is clean. Anything that
 * stops the linter from judging the document, such as an unreadable file or a document with no
 * operations to judge, throws instead of passing.
 */
export async function lintOpenApi(file: string): Promise<string[]> {
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  const paths = isRecord(parsed) ? parsed["paths"] : undefined;
  const operations = isRecord(paths)
    ? Object.values(paths).flatMap((item) => (isRecord(item) ? Object.keys(item).filter((key) => METHODS.includes(key)) : []))
    : [];
  if (operations.length === 0) {
    throw new Error(`${file} declares no operations, so there is nothing for the ruleset to check`);
  }
  const spectral = new Spectral();
  spectral.setRuleset(ruleset);
  const results = await spectral.run(new Document(text, parsers.Json, file));
  return results.map(
    (result) => `[${String(result.code)}] ${operationOf(parsed, result.path)} at ${pointer(result.path)}: ${result.message}`,
  );
}
