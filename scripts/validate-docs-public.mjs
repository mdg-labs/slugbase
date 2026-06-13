#!/usr/bin/env node
/**
 * Validates docs/public/ for Documentation.AI publish contract.
 * Does NOT scan docs/internal/.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DOCS_PUBLIC_ROOT = resolve(__dirname, "../docs/public");

const LOWERCASE_HYHEN_MDX = /^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * @param {string} root
 * @returns {string[]}
 */
export function listMdxFiles(root) {
  /** @type {string[]} */
  const files = [];

  function walk(dir) {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  return files.sort();
}

/**
 * @param {string} content
 * @returns {{ title?: string; description?: string }}
 */
export function parseFrontmatter(content) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return {};
  }

  /** @type {{ title?: string; description?: string }} */
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "title" || key === "description") {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * @param {unknown} node
 * @param {{ paths: string[]; openapis: string[]; hasPagePaths: boolean }} acc
 */
function collectNavReferences(node, acc) {
  if (node === null || typeof node !== "object") {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectNavReferences(item, acc);
    }
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (node);

  if (typeof record.path === "string" && record.path.length > 0) {
    acc.paths.push(record.path);
    acc.hasPagePaths = true;
  }

  if (typeof record.openapi === "string" && record.openapi.length > 0) {
    acc.openapis.push(record.openapi);
  }

  for (const value of Object.values(record)) {
    collectNavReferences(value, acc);
  }
}

/**
 * @param {string} root
 * @returns {{ config: Record<string, unknown>; errors: string[]; warnings: string[] }}
 */
export function loadDocumentationJson(root) {
  const configPath = join(root, "documentation.json");
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!existsSync(configPath)) {
    errors.push("missing documentation.json at docs/public/documentation.json");
    return { config: {}, errors, warnings };
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`documentation.json is not valid JSON: ${message}`);
    return { config: {}, errors, warnings };
  }

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    errors.push("documentation.json must be a JSON object");
    return { config: {}, errors, warnings };
  }

  const record = /** @type {Record<string, unknown>} */ (config);
  if (typeof record.name !== "string" || record.name.trim() === "") {
    errors.push('documentation.json missing required string key "name"');
  }
  if (typeof record.navigation !== "object" || record.navigation === null) {
    errors.push('documentation.json missing required object key "navigation"');
  }

  return { config: record, errors, warnings };
}

/**
 * @param {string} root
 * @param {{ strictOrphans?: boolean }} [options]
 * @returns {{ ok: boolean; errors: string[]; warnings: string[] }}
 */
export function validateDocsPublic(root, options = {}) {
  const { strictOrphans = false } = options;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  const { config, errors: configErrors } = loadDocumentationJson(root);
  errors.push(...configErrors);

  const mdxFiles = listMdxFiles(root);
  const mdxRelPaths = new Set(
    mdxFiles.map((file) => relative(root, file).replace(/\\/g, "/").replace(/\.mdx$/, "")),
  );

  for (const file of mdxFiles) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const base = rel.split("/").pop() ?? rel;
    if (!LOWERCASE_HYHEN_MDX.test(base)) {
      errors.push(`MDX filename must be lowercase-with-hyphens: ${rel}`);
    }

    const content = readFileSync(file, "utf8");
    const { title, description } = parseFrontmatter(content);
    if (!title || title.trim() === "") {
      errors.push(`missing frontmatter title: ${rel}`);
    }
    if (!description || description.trim() === "") {
      errors.push(`missing frontmatter description: ${rel}`);
    }
  }

  const nav = { paths: [], openapis: [], hasPagePaths: false };
  if (Object.keys(config).length > 0) {
    collectNavReferences(config.navigation, nav);

    for (const pagePath of nav.paths) {
      if (!mdxRelPaths.has(pagePath)) {
        errors.push(
          `documentation.json path "${pagePath}" does not resolve to ${pagePath}.mdx`,
        );
      }
    }

    const initialRoute =
      typeof config.initialRoute === "string" ? config.initialRoute : undefined;
    if (initialRoute) {
      const shouldRequireInitialRoute =
        nav.hasPagePaths || mdxRelPaths.has(initialRoute);
      if (shouldRequireInitialRoute && !mdxRelPaths.has(initialRoute)) {
        errors.push(
          `initialRoute "${initialRoute}" does not resolve to ${initialRoute}.mdx`,
        );
      } else if (!mdxRelPaths.has(initialRoute)) {
        warnings.push(
          `initialRoute "${initialRoute}" has no matching MDX file yet (expected after content migration)`,
        );
      }
    }

    const shouldRequireOpenapi = nav.hasPagePaths || mdxFiles.length > 0;
    for (const openapiPath of nav.openapis) {
      const abs = join(root, openapiPath);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        if (shouldRequireOpenapi) {
          errors.push(
            `documentation.json openapi "${openapiPath}" does not resolve to an existing file`,
          );
        } else {
          warnings.push(
            `documentation.json openapi "${openapiPath}" is not present yet (expected after content migration)`,
          );
        }
      }
    }
  }

  const referencedPaths = new Set(nav.paths);
  if (typeof config.initialRoute === "string") {
    referencedPaths.add(config.initialRoute);
  }

  for (const relPath of mdxRelPaths) {
    if (!referencedPaths.has(relPath)) {
      const message = `orphan MDX not referenced in documentation.json navigation: ${relPath}.mdx`;
      if (strictOrphans) {
        errors.push(message);
      } else {
        warnings.push(message);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function main() {
  const root = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : DEFAULT_DOCS_PUBLIC_ROOT;
  const strictOrphans = process.argv.includes("--strict-orphans");

  const result = validateDocsPublic(root, { strictOrphans });

  for (const warning of result.warnings) {
    console.warn(`warn: ${warning}`);
  }

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`error: ${error}`);
    }
    console.error(`validate-docs-public: ${result.errors.length} error(s)`);
    process.exit(1);
  }

  console.log(`validate-docs-public: OK (${root})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
