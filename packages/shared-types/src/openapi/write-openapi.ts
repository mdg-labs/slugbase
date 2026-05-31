import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildOpenApiDocument,
  OPENAPI_OUTPUT_PATH,
} from "../openapi/generate-openapi.js";

export function writeOpenApiDocument(
  outputPath: string = OPENAPI_OUTPUT_PATH,
): void {
  const document = buildOpenApiDocument();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

export function resolveDefaultOpenApiOutputPath(): string {
  return resolve(process.cwd(), OPENAPI_OUTPUT_PATH);
}
