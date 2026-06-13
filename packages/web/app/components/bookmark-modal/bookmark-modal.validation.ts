import type {
  BookmarkModalFieldErrors,
  BookmarkModalFormValues,
} from "./bookmark-modal.types.js";

/** Slug grammar - docs/internal/defaults-and-constants.md §1, spec §8. */
const SLUG_GRAMMAR = /^[a-z0-9][a-z0-9-]{0,63}$/;

const RESERVED_SLUGS = new Set([
  "go",
  "api",
  "auth",
  "health",
  "version",
  "login",
  "logout",
  "setup",
]);

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateBookmarkModalForm(
  values: BookmarkModalFormValues,
  t: (key: string) => string,
): BookmarkModalFieldErrors {
  const errors: BookmarkModalFieldErrors = {};

  const url = values.url.trim();
  if (!url) {
    errors.url = t("bookmark.modal.error.url_required");
  } else if (url.length > 2048) {
    errors.url = t("bookmark.modal.error.url_too_long");
  } else if (!isValidHttpUrl(url)) {
    errors.url = t("bookmark.modal.error.url_invalid");
  }

  const title = values.title.trim();
  if (!title) {
    errors.title = t("bookmark.modal.error.title_required");
  } else if (title.length > 500) {
    errors.title = t("bookmark.modal.error.title_too_long");
  }

  const slug = values.slug.trim();
  if (values.forwardingEnabled && !slug) {
    errors.slug = t("bookmark.modal.error.slug_required_for_forwarding");
  } else if (slug) {
    if (!SLUG_GRAMMAR.test(slug)) {
      errors.slug = t("bookmark.modal.error.slug_invalid");
    } else if (RESERVED_SLUGS.has(slug)) {
      errors.slug = t("bookmark.modal.error.slug_reserved");
    }
  }

  return errors;
}

export function hasBookmarkModalErrors(errors: BookmarkModalFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export function toBookmarkSubmitBody(values: BookmarkModalFormValues): {
  title: string;
  url: string;
  slug: string | null;
  forwardingEnabled: boolean;
  pinned: boolean;
} {
  const slug = values.slug.trim();
  return {
    title: values.title.trim(),
    url: values.url.trim(),
    slug: slug.length > 0 ? slug : null,
    forwardingEnabled: values.forwardingEnabled,
    pinned: values.pinned,
  };
}
