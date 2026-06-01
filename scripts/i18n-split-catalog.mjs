#!/usr/bin/env node
/**
 * One-time / maintenance: split staticMessages from messages.ts into locales/*.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { staticMessages as webMessages } from "../packages/web/app/i18n/messages.ts";
import { staticMessages as marketingMessages } from "../packages/marketing/src/i18n/messages.ts";
import { readSupportedLocales } from "./i18n-catalog-utils.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

/** @param {Record<string, string>} catalog */
function writeSortedJson(path, catalog) {
  const sorted = Object.fromEntries(
    Object.keys(catalog)
      .sort()
      .map((key) => [key, catalog[key]]),
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

const targets = [
  {
    name: "web",
    messages: webMessages,
    dir: join(repoRoot, "packages/web/app/i18n/locales"),
  },
  {
    name: "marketing",
    messages: marketingMessages,
    dir: join(repoRoot, "packages/marketing/src/i18n/locales"),
  },
];

for (const { name, messages, dir } of targets) {
  mkdirSync(dir, { recursive: true });
  for (const locale of readSupportedLocales()) {
    const catalog = messages[locale];
    if (!catalog) {
      throw new Error(`missing ${locale} in ${name} staticMessages`);
    }
    writeSortedJson(join(dir, `${locale}.json`), catalog);
  }
}

console.log("i18n-split-catalog: wrote locale JSON for web + marketing");
