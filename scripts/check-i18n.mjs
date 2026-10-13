// Checks the i18n catalogs and the strings of one package (D19, doc 08 section 4):
//
//   node scripts/check-i18n.mjs [--require-catalogs] <package-dir>
//
// - the EN and DE catalogs hold the same keys, and each key the same
//   placeholders and the same plural and select options in both;
// - every message parses as ICU MessageFormat;
// - every key is referenced by a literal `t("key")` / `i18nKey="key"` in the
//   package's source, and every referenced key is in the catalogs;
// - no JSX of the package carries a literal string (scripts/i18n-eslint.mjs).
//
// A package without catalogs passes the catalog checks unless
// --require-catalogs is given.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { ESLint } from "eslint";
import ts from "typescript";
import tseslint from "typescript-eslint";
import { literalStringConfig } from "./i18n-eslint.mjs";

const LOCALES = ["en", "de"];
const REFERENCE = "en";
const CATALOG_DIRS = [join("src", "i18n", "locales"), join("src", "i18n")];

function walk(dir, visit) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist") {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}

function flatten(value, prefix, file, problems, out) {
  if (typeof value === "string") {
    out.set(prefix, value);
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix === "" ? key : `${prefix}.${key}`, file, problems, out);
    }
  } else {
    problems.push(`${file}: "${prefix}" is not a string or an object of strings`);
  }
}

function loadCatalogs(root, problems) {
  const dir = CATALOG_DIRS.map((candidate) => join(root, candidate)).find((candidate) =>
    LOCALES.some((locale) => existsSync(join(candidate, `${locale}.json`))),
  );
  if (dir === undefined) {
    return undefined;
  }
  const catalogs = new Map();
  for (const locale of LOCALES) {
    const file = join(dir, `${locale}.json`);
    const shown = relative(root, file);
    const messages = new Map();
    catalogs.set(locale, { file: shown, messages });
    if (!existsSync(file)) {
      problems.push(`${shown}: the ${locale} catalog is missing`);
      continue;
    }
    try {
      flatten(JSON.parse(readFileSync(file, "utf8")), "", shown, problems, messages);
    } catch (error) {
      problems.push(`${shown}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return catalogs;
}

/** The placeholders of a parsed message, and the options of its plural and select arguments. */
function describeMessage(elements, out = { placeholders: new Set(), options: new Set() }) {
  for (const element of elements) {
    switch (element.type) {
      case TYPE.argument:
        out.placeholders.add(`{${element.value}}`);
        break;
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        out.placeholders.add(`{${element.value}, ${TYPE[element.type]}}`);
        break;
      case TYPE.select:
      case TYPE.plural: {
        const kind = element.type === TYPE.select ? "select" : element.pluralType === "ordinal" ? "selectordinal" : "plural";
        out.placeholders.add(`{${element.value}, ${kind}}`);
        for (const [option, branch] of Object.entries(element.options)) {
          out.options.add(`{${element.value}, ${kind}} ${option}`);
          describeMessage(branch.value, out);
        }
        break;
      }
      case TYPE.tag:
        out.placeholders.add(`<${element.value}>`);
        describeMessage(element.children, out);
        break;
      default:
        break;
    }
  }
  return out;
}

const sorted = (set) => [...set].sort();
const list = (set) => (set.size === 0 ? "none" : sorted(set).join(", "));

function sameSet(a, b) {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function checkCatalogs(catalogs, problems) {
  const reference = catalogs.get(REFERENCE);
  const described = new Map();
  for (const [locale, { file, messages }] of catalogs) {
    const parsed = new Map();
    described.set(locale, parsed);
    for (const [key, message] of messages) {
      try {
        parsed.set(key, describeMessage(parse(message)));
      } catch (error) {
        const reason = error instanceof SyntaxError ? error.message : String(error);
        problems.push(`${file}: "${key}" is not a valid ICU message (${reason}): ${message}`);
      }
    }
  }
  for (const [locale, { file, messages }] of catalogs) {
    if (locale === REFERENCE) {
      continue;
    }
    for (const key of reference.messages.keys()) {
      if (!messages.has(key)) {
        problems.push(`${file}: "${key}" is in ${REFERENCE}.json but missing here`);
      }
    }
    for (const key of messages.keys()) {
      if (!reference.messages.has(key)) {
        problems.push(`${file}: "${key}" is not in ${reference.file}`);
      }
    }
    for (const [key, theirs] of described.get(locale)) {
      const ours = described.get(REFERENCE).get(key);
      if (ours === undefined) {
        continue;
      }
      if (!sameSet(ours.placeholders, theirs.placeholders)) {
        problems.push(
          `${file}: "${key}" has other placeholders than ${REFERENCE}.json (${REFERENCE}: ${list(ours.placeholders)}; ${locale}: ${list(theirs.placeholders)})`,
        );
      }
      if (!sameSet(ours.options, theirs.options)) {
        problems.push(
          `${file}: "${key}" has other plural or select options than ${REFERENCE}.json (${REFERENCE}: ${list(ours.options)}; ${locale}: ${list(theirs.options)})`,
        );
      }
    }
  }
}

function stripWrappers(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The keys a `t()` argument can be, or undefined when it is not made of string literals. */
function literalKeys(argument) {
  const node = stripWrappers(argument);
  if (ts.isStringLiteralLike(node)) {
    return [node.text];
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literalKeys(node.whenTrue);
    const whenFalse = literalKeys(node.whenFalse);
    return whenTrue === undefined || whenFalse === undefined ? undefined : [...whenTrue, ...whenFalse];
  }
  if (ts.isArrayLiteralExpression(node)) {
    const keys = node.elements.map((element) => literalKeys(element));
    return keys.some((entry) => entry === undefined) ? undefined : keys.flat();
  }
  return undefined;
}

function isTranslateCall(node) {
  const callee = stripWrappers(node.expression);
  return (ts.isIdentifier(callee) && callee.text === "t") || (ts.isPropertyAccessExpression(callee) && callee.name.text === "t");
}

function collectReferences(root, problems) {
  const references = new Map();
  const src = join(root, "src");
  if (!existsSync(src)) {
    return references;
  }
  walk(src, (file) => {
    if (!/\.tsx?$/.test(file) || /\.d\.ts$|\.test\.tsx?$|\.gen\.ts$/.test(file)) {
      return;
    }
    const shown = relative(root, file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const at = (node) => `${shown}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)}`;
    const reference = (key, node) => {
      references.set(key, references.get(key) ?? at(node));
    };
    const visit = (node) => {
      if (ts.isCallExpression(node) && isTranslateCall(node)) {
        const [argument] = node.arguments;
        const keys = argument === undefined ? undefined : literalKeys(argument);
        if (keys === undefined) {
          problems.push(`${at(node)}: the key of t() must be a string literal, so that it can be checked against the catalogs`);
        } else {
          keys.forEach((key) => {
            reference(key, node);
          });
        }
      } else if (ts.isJsxAttribute(node) && node.name.getText(source) === "i18nKey") {
        const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
        const keys = value === undefined ? undefined : literalKeys(value);
        if (keys === undefined) {
          problems.push(`${at(node)}: i18nKey must be a string literal, so that it can be checked against the catalogs`);
        } else {
          keys.forEach((key) => {
            reference(key, node);
          });
        }
      } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(source) === "keyPrefix") {
        problems.push(`${at(node)}: keyPrefix hides the full key from the check; write the full key in t()`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  });
  return references;
}

function checkReferences(catalogs, references, problems) {
  if (catalogs === undefined) {
    for (const [key, where] of references) {
      problems.push(`${where}: "${key}" is used but the package has no catalogs`);
    }
    return;
  }
  const reference = catalogs.get(REFERENCE);
  for (const [key, where] of references) {
    if (!reference.messages.has(key)) {
      problems.push(`${where}: "${key}" is used but is not in ${reference.file}`);
    }
  }
  for (const { file, messages } of catalogs.values()) {
    for (const key of messages.keys()) {
      if (!references.has(key)) {
        problems.push(`${file}: "${key}" is not used by any t() call`);
      }
    }
  }
}

async function checkLiteralStrings(root, problems) {
  const manifest = existsSync(join(root, "package.json")) ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")) : {};
  const vendored = manifest.name === "@slugbase/ui" ? "src/components/ui/**" : null;
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    errorOnUnmatchedPattern: false,
    overrideConfig: [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" } },
        // Sources carry disable comments for the repository's other rules; they need a definition to be read.
        plugins: { "@typescript-eslint": tseslint.plugin },
        linterOptions: { reportUnusedDisableDirectives: "off" },
      },
      literalStringConfig(["src/**/*.tsx"], vendored),
    ],
  });
  for (const result of await eslint.lintFiles(["src/**/*.tsx"])) {
    for (const message of result.messages) {
      problems.push(`${relative(root, result.filePath)}:${String(message.line)}:${String(message.column)}: ${message.message}`);
    }
  }
}

/** Checks one package; returns the problems found, empty when it is clean. */
export async function checkPackage(packageDir, { requireCatalogs = false } = {}) {
  const root = resolve(packageDir);
  const problems = [];
  const catalogs = loadCatalogs(root, problems);
  if (catalogs === undefined && requireCatalogs) {
    problems.push(`${basename(root)}: no catalogs found in ${CATALOG_DIRS.join(" or ")}`);
  }
  if (catalogs !== undefined) {
    checkCatalogs(catalogs, problems);
  }
  checkReferences(catalogs, collectReferences(root, problems), problems);
  await checkLiteralStrings(root, problems);
  return problems;
}

async function main(argv) {
  const requireCatalogs = argv.includes("--require-catalogs");
  const [packageDir] = argv.filter((argument) => !argument.startsWith("--"));
  if (packageDir === undefined) {
    process.stderr.write("usage: node scripts/check-i18n.mjs [--require-catalogs] <package-dir>\n");
    return 2;
  }
  const problems = await checkPackage(packageDir, { requireCatalogs });
  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }
  if (problems.length > 0) {
    process.stderr.write(`i18n: ${String(problems.length)} problem(s) in ${basename(resolve(packageDir))}\n`);
    return 1;
  }
  process.stdout.write(`i18n: ${basename(resolve(packageDir))} is clean\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`i18n: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
