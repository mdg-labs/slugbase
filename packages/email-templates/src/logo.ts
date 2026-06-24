import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Content-ID referenced by {@link renderLayout} header image. */
export const SLUGBASE_LOGO_CID = "slugbase-logo" as const;

/** Filename for the inline PNG attachment. */
export const SLUGBASE_LOGO_FILENAME = "slugbase_icon.png";

/**
 * Absolute path to the SlugBase logo PNG bundled with this package.
 * Resolved relative to compiled output so it works in Docker and local dev.
 */
export function resolveSlugbaseLogoPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../assets",
    SLUGBASE_LOGO_FILENAME,
  );
}
