import { posix } from "node:path";
import { IMAGE_EXTENSIONS } from "./contract.ts";
import type { AstNode } from "./mdx.ts";

export interface Ref {
  kind: "link" | "image";
  url: string;
  line: number;
  /** A link a GFM renderer makes of an address written in the text, without brackets or angle brackets. */
  bare?: boolean;
}

export interface PageRefs {
  refs: Ref[];
  /** The fragment each heading of the page answers to. */
  headings: Set<string>;
}

/** True for a link whose only content is the characters that make it: a bare address. */
function isBareAddress(node: AstNode): boolean {
  const [only, ...rest] = node.children ?? [];
  if (only === undefined || rest.length > 0 || only.type !== "text") return false;
  const outer = node.position;
  const inner = only.position;
  return (
    outer?.start.offset !== undefined &&
    outer.start.offset === inner?.start.offset &&
    outer.end.offset !== undefined &&
    outer.end.offset === inner.end.offset
  );
}

function textOf(node: AstNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** The fragment a heading answers to: lower case, punctuation dropped, spaces as hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Collects the links, the images and the headings of a parsed page. */
export function collectRefs(tree: AstNode): PageRefs {
  const refs: Ref[] = [];
  const headings = new Set<string>();
  const seenSlugs = new Map<string, number>();
  const definitions: { identifier: string; url: string; line: number }[] = [];
  const linkUsed = new Set<string>();
  const imageUsed = new Set<string>();

  const visit = (node: AstNode): void => {
    const line = node.position?.start.line ?? 1;
    switch (node.type) {
      case "link":
        refs.push({ kind: "link", url: node.url ?? "", line, ...(isBareAddress(node) ? { bare: true } : {}) });
        break;
      case "image":
        refs.push({ kind: "image", url: node.url ?? "", line });
        break;
      case "definition":
        definitions.push({ identifier: node.identifier ?? "", url: node.url ?? "", line });
        break;
      case "linkReference":
        linkUsed.add(node.identifier ?? "");
        break;
      case "imageReference":
        imageUsed.add(node.identifier ?? "");
        break;
      case "heading": {
        const base = slugify(textOf(node));
        const count = seenSlugs.get(base) ?? 0;
        seenSlugs.set(base, count + 1);
        headings.add(count === 0 ? base : `${base}-${String(count)}`);
        break;
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        if (node.name !== "Screenshot") break;
        const src = node.attributes?.find((attribute) => attribute.name === "src");
        if (typeof src?.value === "string") refs.push({ kind: "image", url: src.value, line });
        break;
      }
      default:
        break;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);

  for (const definition of definitions) {
    const asImage = imageUsed.has(definition.identifier);
    const asLink = linkUsed.has(definition.identifier) || !asImage;
    if (asLink) refs.push({ kind: "link", url: definition.url, line: definition.line });
    if (asImage) refs.push({ kind: "image", url: definition.url, line: definition.line });
  }
  return { refs, headings };
}

export interface LinkContext {
  /** The page that holds the reference, relative to the repository root. */
  page: string;
  /** Every page and image of the content roots, relative to the repository root. */
  files: ReadonlySet<string>;
  /** Every image of the content roots. */
  images: ReadonlySet<string>;
  /** The routes the pages produce. */
  routes: ReadonlySet<string>;
  headings: ReadonlySet<string>;
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function hasUnsafeCharacter(url: string): boolean {
  for (const character of url) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || character === "\\") return true;
  }
  return false;
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** The most often a path is percent-decoded; a link encoded more often than that is refused. */
const MAX_DECODE_ROUNDS = 4;

/** The percent sequences that can make or hide a `..` segment: a dot, either separator, a percent sign. */
const SIGNIFICANT_ESCAPE = /%(2e|2f|5c|25)/gi;

function unescapeSignificant(text: string): string {
  return text.replace(SIGNIFICANT_ESCAPE, (_, hex: string) => {
    switch (hex.toLowerCase()) {
      case "2e":
        return ".";
      case "2f":
        return "/";
      case "5c":
        return "\\";
      default:
        return "%";
    }
  });
}

/**
 * True when a path holds a `..` segment once percent-decoding is undone, however
 * many times it was applied, and whether the separator is `/` or `\`. A browser
 * resolves such a segment, so `/docs/cloud/../../pricing` leaves /docs/.
 *
 * Each round decodes only the well-formed sequences above and leaves every other
 * byte, including a malformed `%`, as it is, so nothing in the path can stop the
 * rest of it from being judged.
 */
function leavesItsFolder(path: string): boolean {
  let current = path;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    if (current.split(/[/\\]/).includes("..")) return true;
    const next = unescapeSignificant(current);
    if (next === current) return false;
    current = next;
  }
  // Encoded more often than any page needs: refuse it rather than guess.
  return true;
}

function pathPart(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

const IMAGE_RULE = `an image is a relative path to a file next to the page (${IMAGE_EXTENSIONS.map((extension) => extension.slice(1)).join(", ")})`;

/** Returns why a link is refused, or null when it is fine. */
export function checkLink(url: string, context: LinkContext): string | null {
  if (url === "") return "the link has no target";
  if (hasUnsafeCharacter(url)) return `"${url}" holds a space, a control character or a backslash; percent-encode it`;

  if (url.startsWith("#")) {
    const fragment = decode(url.slice(1));
    if (fragment === null || fragment === "" || !context.headings.has(fragment)) {
      return `"${url}" matches no heading of this page`;
    }
    return null;
  }

  const scheme = SCHEME.exec(url);
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() === "https" && /^https:\/\/[^/?#]+/i.test(url)) return null;
    return `"${url}" uses the ${(scheme[1] ?? "").toLowerCase()}: scheme; only https:// links to other sites are allowed`;
  }
  if (url.startsWith("//")) return `"${url}" is a protocol-relative address; write the full https:// address`;

  const path = decode(pathPart(url));
  if (path === null || path === "") return `"${url}" is not a valid link target`;

  if (url.startsWith("/")) {
    if (path !== "/docs" && !path.startsWith("/docs/")) {
      return `"${url}" is a root-absolute link that is not /docs/...; write the full https:// address of the public site`;
    }
    if (leavesItsFolder(pathPart(url))) {
      return `"${url}" climbs out of its path with ".."; write the route of the page without ".." segments`;
    }
    const route = path.replace(/\/+$/, "");
    if (route === "/docs/cloud" || route.startsWith("/docs/cloud/")) return null;
    return context.routes.has(route) ? null : `"${url}" matches no page: nothing produces the route ${route}`;
  }

  const target = posix.join(posix.dirname(context.page), path);
  return context.files.has(target) ? null : `"${url}" does not resolve to a page or file in the content roots`;
}

/** Returns why an image is refused, or null when it is fine. */
export function checkImage(url: string, context: LinkContext): string | null {
  if (url === "") return "the image has no source";
  if (hasUnsafeCharacter(url)) return `"${url}" holds a space, a control character or a backslash; percent-encode it`;
  if (SCHEME.test(url) || url.startsWith("/")) return `"${url}" is absolute or remote; ${IMAGE_RULE}`;
  if (/[?#]/.test(url)) return `"${url}" must be a plain file path without a query or a fragment`;

  const path = decode(url);
  if (path === null) return `"${url}" is not a valid file path`;
  if (path.split("/").includes("..")) return `"${url}" leaves the page's folder; ${IMAGE_RULE}`;

  const extension = posix.extname(path).toLowerCase();
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(extension)) {
    return `"${url}" has the extension "${extension}"; ${IMAGE_RULE}`;
  }
  const target = posix.join(posix.dirname(context.page), path);
  return context.images.has(target) ? null : `"${url}" is not a file next to the page (${target} does not exist)`;
}
