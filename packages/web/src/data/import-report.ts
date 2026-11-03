import { saveFile } from "./export-api.ts";
import type { ImportResult } from "./import-api.ts";

export const IMPORT_REPORT_FILE_NAME = "slugbase-import-report.json";

/** Saves the whole result of an import as a JSON file, made here from the answer the page already holds. */
export function saveImportReport(result: ImportResult): void {
  saveFile({ blob: new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }), fileName: IMPORT_REPORT_FILE_NAME, count: undefined });
}
