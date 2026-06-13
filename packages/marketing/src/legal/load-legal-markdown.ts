import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

export type LegalTab = "impressum" | "agb" | "datenschutz";
export type SupportedLocale = "en" | "de";

function findDraftsDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "docs/internal/legal/drafts");
    if (existsSync(join(candidate, "impressum.md"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Legal drafts directory not found (docs/internal/legal/drafts)");
    }
    dir = parent;
  }
}

const draftsDir = findDraftsDir(dirname(fileURLToPath(import.meta.url)));

const LOCALE_SECTION: Record<SupportedLocale, { start: string; end: string | null }> = {
  en: { start: "## English", end: "## Deutsch" },
  de: { start: "## Deutsch", end: null },
};

const draftFileNames: Record<LegalTab, string> = {
  impressum: "impressum.md",
  agb: "agb.md",
  datenschutz: "datenschutz.md",
};

export function extractLocaleMarkdown(fullDraft: string, locale: SupportedLocale): string {
  const { start, end } = LOCALE_SECTION[locale];
  const startIdx = fullDraft.indexOf(start);
  if (startIdx === -1) {
    throw new Error(`Legal draft missing section marker: ${start}`);
  }

  let section = fullDraft.slice(startIdx + start.length);
  if (end) {
    const endIdx = section.indexOf(end);
    if (endIdx !== -1) {
      section = section.slice(0, endIdx);
    }
  }

  return section.replace(/\n---\s*$/, "").trim();
}

export function loadLegalMarkdown(tab: LegalTab, locale: SupportedLocale): string {
  const draftPath = join(draftsDir, draftFileNames[tab]);
  const fullDraft = readFileSync(draftPath, "utf8");
  return extractLocaleMarkdown(fullDraft, locale);
}

export function renderLegalHtml(tab: LegalTab, locale: SupportedLocale): string {
  const markdown = loadLegalMarkdown(tab, locale);
  return marked.parse(markdown, { async: false, gfm: true });
}
