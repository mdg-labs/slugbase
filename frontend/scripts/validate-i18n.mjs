#!/usr/bin/env node
/**
 * i18n validation script for SlugBase locales.
 * - Validates JSON syntax
 * - Ensures all locale files have the same keys (using en.json as reference)
 * - Reports missing keys, extra keys, and parse errors
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '../src/locales');

/**
 * Flatten nested object to dot-notation keys.
 * @param {object} obj
 * @param {string} prefix
 * @returns {Set<string>}
 */
function flattenKeys(obj, prefix = '') {
  const keys = new Set();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of flattenKeys(value, fullKey)) {
        keys.add(k);
      }
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

/**
 * Load and parse a locale file.
 * @param {string} filePath
 * @returns {{ data: object, error?: string }}
 */
function loadLocale(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return { data };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

function main() {
  const files = readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (files.length === 0) {
    console.error('No locale files found in', LOCALES_DIR);
    process.exit(1);
  }

  const results = {};
  let hasErrors = false;

  for (const file of files) {
    const locale = file.replace('.json', '');
    const filePath = join(LOCALES_DIR, file);
    const { data, error } = loadLocale(filePath);

    if (error) {
      results[locale] = { error };
      hasErrors = true;
      continue;
    }

    results[locale] = { keys: flattenKeys(data), data };
  }

  // Use en as reference
  const reference = results.en;
  if (!reference || reference.error) {
    console.error('Reference locale (en.json) is invalid or missing.');
    process.exit(1);
  }

  const referenceKeys = reference.keys;

  // Report
  console.log('i18n validation report\n');
  console.log('Reference: en.json');
  console.log(`Total keys in reference: ${referenceKeys.size}\n`);

  for (const [locale, { error, keys }] of Object.entries(results)) {
    if (error) {
      console.log(`❌ ${locale}: JSON parse error - ${error}`);
      hasErrors = true;
      continue;
    }

    const missing = [...referenceKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !referenceKeys.has(k));

    if (missing.length === 0 && extra.length === 0) {
      console.log(`✅ ${locale}: OK (${keys.size} keys)`);
    } else {
      hasErrors = true;
      if (missing.length > 0) {
        console.log(`❌ ${locale}: ${missing.length} missing key(s)`);
        for (const k of missing.slice(0, 20)) {
          console.log(`   - ${k}`);
        }
        if (missing.length > 20) {
          console.log(`   ... and ${missing.length - 20} more`);
        }
      }
      if (extra.length > 0) {
        console.log(`⚠️  ${locale}: ${extra.length} extra key(s) (not in en)`);
        for (const k of extra.slice(0, 10)) {
          console.log(`   + ${k}`);
        }
        if (extra.length > 10) {
          console.log(`   ... and ${extra.length - 10} more`);
        }
      }
      console.log('');
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log('\nAll locales valid and in sync.');
}

main();
