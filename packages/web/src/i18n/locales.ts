import de from "./locales/de.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export type Catalog = typeof en;

/** The English catalog is the source of the key types; German must carry the same keys. */
export const CATALOGS = { en, de } satisfies Record<Locale, Catalog>;
