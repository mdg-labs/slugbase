import { readFileSync } from "node:fs";

export type Locale = "en" | "de";

type Catalog = { readonly [key: string]: string | Catalog };

const catalogs = new Map<Locale, Catalog>();

function isCatalog(value: unknown): value is Catalog {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogOf(locale: Locale): Catalog {
  let catalog = catalogs.get(locale);
  if (catalog === undefined) {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL(`../../packages/web/src/i18n/locales/${locale}.json`, import.meta.url), "utf8"),
    );
    if (!isCatalog(parsed)) {
      throw new Error(`the ${locale} catalog is not a JSON object`);
    }
    catalog = parsed;
    catalogs.set(locale, catalog);
  }
  return catalog;
}

// `{count, plural, one {# bookmark} other {# bookmarks}}`: the two forms the English and German catalogs use.
const PLURAL = /\{count, plural, one \{([^{}]*)\} other \{([^{}]*)\}\}/g;

/**
 * The text the web app shows for a catalog key (`errorPage.notFound.title`) in a
 * language, read from the catalogs of packages/web, so the journeys follow the
 * copy instead of repeating it. `{name}` style placeholders take their values
 * from `values`; a text with a `{count, plural, one {…} other {…}}` form takes the
 * form that `values.count` selects, with `#` as the count. A key or a placeholder
 * that does not exist is an error.
 */
export function message(locale: Locale, key: string, values: Readonly<Record<string, string>> = {}): string {
  let node: string | Catalog | undefined = catalogOf(locale);
  for (const part of key.split(".")) {
    node = isCatalog(node) ? node[part] : undefined;
  }
  if (typeof node !== "string") {
    throw new Error(`the ${locale} catalog has no text at ${key}`);
  }
  const expanded = node.replace(PLURAL, (_match, one: string, other: string) => {
    const count = values.count;
    if (count === undefined) {
      throw new Error(`the text at ${key} needs a value for {count}`);
    }
    return (Number(count) === 1 ? one : other).replaceAll("#", count);
  });
  return expanded.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`the text at ${key} needs a value for {${name}}`);
    }
    return value;
  });
}
