import type { ImportBookmarkInput } from "./import.types.js";

type ParsedAnchor = {
  title: string;
  url: string;
  folderName: string | null;
};

const ANCHOR_RE =
  /<DT>\s*<A\b[^>]*\bHREF\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/A>/gi;

const FOLDER_RE = /<DT>\s*<H3\b[^>]*>([\s\S]*?)<\/H3>/gi;
const DL_OPEN_RE = /<DL\b[^>]*>/gi;
const DL_CLOSE_RE = /<\/DL>/gi;

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, "").trim());
}

type Token =
  | { type: "dl_open"; index: number }
  | { type: "dl_close"; index: number }
  | { type: "folder"; index: number; name: string }
  | { type: "anchor"; index: number; url: string; title: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];

  for (const match of html.matchAll(DL_OPEN_RE)) {
    tokens.push({ type: "dl_open", index: match.index });
  }
  for (const match of html.matchAll(DL_CLOSE_RE)) {
    tokens.push({ type: "dl_close", index: match.index });
  }
  for (const match of html.matchAll(FOLDER_RE)) {
    tokens.push({
      type: "folder",
      index: match.index,
      name: stripTags(match[1] ?? ""),
    });
  }
  for (const match of html.matchAll(ANCHOR_RE)) {
    const url = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    tokens.push({
      type: "anchor",
      index: match.index,
      url,
      title: stripTags(match[5] ?? ""),
    });
  }

  tokens.sort((a, b) => a.index - b.index);
  return tokens;
}

function walkTokens(tokens: Token[]): ParsedAnchor[] {
  const results: ParsedAnchor[] = [];
  const folderStack: string[] = [];
  let pendingFolder: string | null = null;

  for (const token of tokens) {
    switch (token.type) {
      case "dl_open":
        if (pendingFolder) {
          folderStack.push(pendingFolder);
          pendingFolder = null;
        }
        break;
      case "dl_close":
        if (folderStack.length > 0) folderStack.pop();
        break;
      case "folder":
        pendingFolder = token.name || null;
        break;
      case "anchor": {
        const folderName =
          folderStack.length > 0 ? folderStack[folderStack.length - 1] ?? null : null;
        results.push({
          title: token.title,
          url: token.url,
          folderName,
        });
        break;
      }
      default:
        break;
    }
  }

  return results;
}

/** Parses a Netscape bookmark HTML export into normalized import entries. */
export function parseNetscapeHtml(html: string): ImportBookmarkInput[] {
  const anchors = walkTokens(tokenize(html));
  const entries: ImportBookmarkInput[] = [];

  for (const anchor of anchors) {
    const title = anchor.title.trim();
    const url = anchor.url.trim();
    if (!title || !url) continue;

    entries.push({
      title,
      url,
      folders: anchor.folderName ? [anchor.folderName] : undefined,
    });
  }

  return entries;
}
