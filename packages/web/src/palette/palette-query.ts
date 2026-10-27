import { BOOKMARK_SLUG_PATTERN } from "@slugbase/contracts";
import { useEffect, useState } from "react";
import { isHttpUrl } from "../bookmarks/bookmarks.ts";

/** How long the query sits idle before the palette searches for it (doc 02 section 9.1). */
export const PALETTE_SEARCH_DELAY_MS = 150;

/**
 * What the palette does with the text in its input. Every mode the palette has is read from the query here, so a mode added to it
 * (`go`) branches from this one place.
 */
export type PaletteMode =
  | { readonly kind: "browse" }
  /** The query is searched for: bookmarks, folders and tags on the server, commands in the browser. */
  | { readonly kind: "search"; readonly text: string };

export function paletteModeOf(query: string): PaletteMode {
  const text = query.trim();
  return text === "" ? { kind: "browse" } : { kind: "search", text };
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
