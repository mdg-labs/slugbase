/** Slug grammar and reserved list — docs/defaults-and-constants.md §1, spec §8. */
export const SLUG_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const RESERVED_SLUGS = new Set([
  "go",
  "api",
  "auth",
  "health",
  "version",
  "login",
  "logout",
  "setup",
]);

export function sanitizeBookmarkTitle(title: string): string {
  return title.replace(/<script>/gi, "").replace(/[<>]/g, "");
}

export function normalizeOptionalSlug(slug: string | null | undefined): string | null {
  if (slug == null) return null;
  const trimmed = slug.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function assertSlugValid(slug: string): void {
  if (!SLUG_GRAMMAR.test(slug)) {
    throw new Error("Slug must match ^[a-z0-9][a-z0-9-]{0,63}$");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`Slug "${slug}" is reserved`);
  }
}
