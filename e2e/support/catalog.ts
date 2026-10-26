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

const PLURAL_START = "{count, plural,";

/** The text between the brace at `open` and the one that closes it, and the index after the closing brace. */
function braced(text: string, open: number, key: string): { body: string; end: number } {
  let depth = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === "{") {
      depth += 1;
    } else if (text[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(open + 1, at), end: at + 1 };
      }
    }
  }
  throw new Error(`the text at ${key} has a brace that is never closed`);
}

/**
 * Replaces every `{count, plural, =0 {…} one {…} other {…}}` of a text with the arm that `values.count` selects (`=N` for
 * the count itself, then `one` for 1, else `other`), `#` standing for the count. An arm may hold placeholders.
 */
function expandPlurals(text: string, key: string, values: Readonly<Record<string, string>>): string {
  let expanded = "";
  let from = 0;
  for (;;) {
    const start = text.indexOf(PLURAL_START, from);
    if (start === -1) {
      return expanded + text.slice(from);
    }
    expanded += text.slice(from, start);
    const count = values.count;
    if (count === undefined) {
      throw new Error(`the text at ${key} needs a value for {count}`);
    }
    const arms = new Map<string, string>();
    let at = start + PLURAL_START.length;
    for (;;) {
      while (text[at] === " ") {
        at += 1;
      }
      if (text[at] === "}") {
        at += 1;
        break;
      }
      const open = text.indexOf("{", at);
      if (open === -1) {
        throw new Error(`the plural at ${key} has an arm without a body`);
      }
      const arm = braced(text, open, key);
      arms.set(text.slice(at, open).trim(), arm.body);
      at = arm.end;
    }
    const chosen = arms.get(`=${count}`) ?? (Number(count) === 1 ? arms.get("one") : undefined) ?? arms.get("other");
    if (chosen === undefined) {
      throw new Error(`the plural at ${key} has no arm for ${count}`);
    }
    expanded += chosen.replaceAll("#", count);
    from = at;
  }
}

/**
 * The text the web app shows for a catalog key (`errorPage.notFound.title`) in a
 * language, read from the catalogs of packages/web, so the journeys follow the
 * copy instead of repeating it. `{name}` style placeholders take their values
 * from `values`; a text with a `{count, plural, …}` form takes the
 * arm that `values.count` selects, with `#` as the count. A key or a placeholder
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
  return expandPlurals(node, key, values).replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`the text at ${key} needs a value for {${name}}`);
    }
    return value;
  });
}
