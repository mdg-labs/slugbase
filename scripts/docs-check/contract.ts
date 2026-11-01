/** The content roots of the docs contract (doc 09 section 3.5), relative to the repository root. */
export const CONTENT_ROOTS = ["docs/user", "docs/self-hosting", "docs/releases"] as const;

export const PAGE_EXTENSIONS = [".md", ".mdx"] as const;
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"] as const;

/** The largest image a content root may hold. */
export const MAX_IMAGE_BYTES = 1024 * 1024;
