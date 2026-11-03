// What the import-and-export journey (tests/import-export.spec.ts) compares: two SlugBase JSON exports once the two fields that are meant to
// differ are removed, and the links of a browser bookmark file (Netscape HTML) before an import and after the export that follows it.

/**
 * An export as the text to compare. `exportedAt` (when the export began) and `workspace.name` (what the workspace is called) are the two fields
 * that are meant to differ between two exports of the same content; they are removed and nothing else is touched, so the order of every list and
 * every field the document holds stand as the server wrote them and a field that went missing, or a list in another order, is a different text.
 */
export function comparableExport(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the export is not a JSON object");
  }
  const document = parsed as Record<string, unknown>;
  if (document.format !== "slugbase-export") {
    throw new Error("the export is not a SlugBase export document");
  }
  delete document.exportedAt;
  const workspace = document.workspace;
  if (typeof workspace !== "object" || workspace === null || Array.isArray(workspace)) {
    throw new Error("the export names no workspace");
  }
  delete (workspace as Record<string, unknown>).name;
  return JSON.stringify(document);
}

/** A link of a browser bookmark file: its address and the title it shows, both as text. */
export interface FileLink {
  readonly url: string;
  readonly title: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text a character reference stands for, for the references a bookmark file holds (the five named ones and the numeric forms). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(\w+));/g, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) {
      return String.fromCodePoint(Number(decimal));
    }
    if (hex !== undefined) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return name === undefined ? whole : (NAMED_ENTITIES[name] ?? whole);
  });
}

/** Every `<A HREF=…>title</A>` of a bookmark file, in the order of the file; the file's text is not interpreted beyond that. */
export function linksOfBookmarkFile(html: string): FileLink[] {
  const links: FileLink[] = [];
  for (const anchor of html.matchAll(/<A\s([^>]*)>([\s\S]*?)<\/A>/gi)) {
    const href = /(?:^|\s)HREF="([^"]*)"/i.exec(anchor[1] ?? "")?.[1];
    if (href !== undefined) {
      links.push({ url: decodeEntities(href), title: decodeEntities(anchor[2] ?? "") });
    }
  }
  return links;
}

/** Whether an address is one an import turns into a bookmark: an http or https address. */
export function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
