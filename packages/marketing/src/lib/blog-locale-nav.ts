import { getRelativeLocaleUrl } from "astro:i18n";
import {
  resolveBlogAlternateHref,
  type BlogPostEntry,
} from "@mdg-labs/blog";
import type { SupportedLocale } from "../i18n/translate.js";

const BLOG_LOCALE_PATH_OPTIONS = {
  enBlogBase: "/blog",
  deBlogBase: "/de/blog",
  enBlogIndex: "/blog",
  deBlogIndex: "/de/blog/",
} as const;

/** Blog index language switcher target (en ↔ de blog home). */
export function resolveBlogIndexAlternateHref(
  locale: SupportedLocale,
): string {
  const alternateLocale: SupportedLocale = locale === "en" ? "de" : "en";
  return getRelativeLocaleUrl(alternateLocale, "/blog");
}

/** Blog post language switcher target via shared translation folder keys. */
export function resolveBlogPostAlternateHref(
  entry: BlogPostEntry,
  posts: BlogPostEntry[],
): string {
  return resolveBlogAlternateHref(entry, posts, BLOG_LOCALE_PATH_OPTIONS);
}
