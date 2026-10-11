import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ForbiddenTerm {
  word: string;
  canonical: string;
}

export const TERMS_FILE = resolve(import.meta.dirname, "forbidden-words.json");

function isTerm(value: unknown): value is ForbiddenTerm {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { word, canonical } = value as Record<string, unknown>;
  return typeof word === "string" && word.trim() !== "" && typeof canonical === "string" && canonical.trim() !== "";
}

export function loadTerms(file: string = TERMS_FILE): ForbiddenTerm[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const terms = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["terms"] : undefined;
  if (!Array.isArray(terms) || terms.length === 0 || !terms.every(isTerm)) {
    throw new Error(`${file}: expected a non-empty "terms" array of { word, canonical } strings`);
  }
  return terms.map((term) => ({ word: term.word.toLowerCase(), canonical: term.canonical }));
}

export function findTerm(text: string, terms: readonly ForbiddenTerm[]): ForbiddenTerm | undefined {
  const lower = text.toLowerCase();
  return terms.find((term) => lower.includes(term.word));
}
