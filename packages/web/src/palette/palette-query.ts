import { BOOKMARK_SLUG_PATTERN } from "@slugbase/contracts";
import { useEffect, useState } from "react";
import { isHttpUrl } from "../bookmarks/bookmarks.ts";

/** How long the query sits idle before the palette searches for it (doc 02 section 9.1). */
export const PALETTE_SEARCH_DELAY_MS = 150;

/**
 * What the palette does with the text in its input. Every mode the palette has is read from the query here, so a mode added to it
 * branches from this one place.
 */
export type PaletteMode =
  | { readonly kind: "browse" }
  /** The query is searched for: bookmarks, folders and tags on the server, commands in the browser. */
  | { readonly kind: "search"; readonly text: string }
  /** The query asks to go to a slug (doc 02 section 9.2). `slug` is everything after `go ` or `/go/`, which may be empty or not a slug at all. */
  | { readonly kind: "go"; readonly slug: string };

const GO_PATH = "/go/";

/** The text after `/go/` in a pasted link of this deployment's own origin, or of no origin at all; undefined for any other text. */
function pastedGoSlug(text: string, origin: string): string | undefined {
  const pasted = /^https?:\/\//i.test(text) || text.startsWith(GO_PATH);
  if (!pasted || !URL.canParse(text, origin)) {
    return undefined;
  }
  const url = new URL(text, origin);
  if (url.origin !== origin || !url.pathname.startsWith(GO_PATH)) {
    return undefined;
  }
  let path = url.pathname.slice(GO_PATH.length);
  try {
    path = decodeURIComponent(path);
  } catch {
    // A path that is not valid percent-encoding is kept as it is; it is no slug either way.
  }
  return `${path}${url.search}`;
}

/**
 * `go ` in any case, a pasted `/go/<slug>` and a pasted link to `/go/<slug>` on `origin` enter go mode. A link on any other origin is
 * only text to search for. A path or query after the slug stays in `slug`, so the server judges it as it does for `/go` (Q43).
 */
export function paletteModeOf(query: string, origin: string = globalThis.location.origin): PaletteMode {
  const text = query.trim();
  if (text === "") {
    return { kind: "browse" };
  }
  const lead = query.trimStart();
  if (/^go\s/i.test(lead)) {
    return { kind: "go", slug: lead.slice(2).trim().toLowerCase() };
  }
  const pasted = pastedGoSlug(text, origin);
  return pasted === undefined ? { kind: "search", text } : { kind: "go", slug: pasted.trim().toLowerCase() };
}

/** What "No results" offers to create: a bookmark for an address, one with a slug, or a blank one. */
export type CreateOffer =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "slug"; readonly slug: string }
  | { readonly kind: "blank" };

/** The address a query looks like: a web address as typed, or a bare host name such as `example.com/page`, which gets `https://`. */
function addressOf(text: string): string | undefined {
  if (/\s/.test(text)) {
    return undefined;
  }
  if (isHttpUrl(text)) {
    return text;
  }
  const candidate = `https://${text}`;
  if (text.includes("://") || !URL.canParse(candidate)) {
    return undefined;
  }
  const labels = new URL(candidate).hostname.split(".");
  const top = labels.at(-1) ?? "";
  return labels.length > 1 && top.length >= 2 && top.split("").every((letter) => letter >= "a" && letter <= "z") ? candidate : undefined;
}

export function createOfferOf(text: string): CreateOffer {
  const url = addressOf(text);
  if (url !== undefined) {
    return { kind: "url", url };
  }
  const slug = text.toLowerCase().replaceAll(/\s+/g, "-");
  return BOOKMARK_SLUG_PATTERN.test(slug) ? { kind: "slug", slug } : { kind: "blank" };
}

/** `value`, once it has stayed the same for `delay` milliseconds. */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return debounced;
}
