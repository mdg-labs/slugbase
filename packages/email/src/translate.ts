import de from "./i18n/de.json" with { type: "json" };
import en from "./i18n/en.json" with { type: "json" };

// The catalogs hold the text of every email (D19). A message's placeholders are
// plain `{name}` ones; `pnpm i18n:check` holds both catalogs to the same keys and
// the same placeholders.

export type Locale = "en" | "de";

export type Translate = (key: string, values?: Readonly<Record<string, string>>) => string;

type Catalog = Readonly<Record<string, unknown>>;

const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, de };

function isLocale(locale: string): locale is Locale {
  return locale === "en" || locale === "de";
}

/** The language a message is written in: the recipient's when there is a catalog for it, English otherwise (doc 02 section 15). */
export function resolveLocale(locale: string): Locale {
  return isLocale(locale) ? locale : "en";
}

function lookup(catalog: Catalog, key: string): string {
  let current: unknown = catalog;
  for (const part of key.split(".")) {
    current = typeof current === "object" && current !== null && Object.hasOwn(current, part) ? Reflect.get(current, part) : undefined;
  }
  if (typeof current !== "string") {
    throw new RangeError(`the email catalog has no message ${key}`);
  }
  return current;
}

export function translator(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  return (key, values = {}) =>
    lookup(catalog, key).replace(/\{(\w+)\}/g, (_placeholder, name: string) => {
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined) {
        throw new RangeError(`the email message ${key} needs a value for ${name}`);
      }
      return value;
    });
}
