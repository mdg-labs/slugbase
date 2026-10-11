import type { Rule, Scope } from "eslint";
import { checkImport, inDbPackage, inEgressDir, locate, repoPath } from "./policy.ts";

export const IMPORT_RULE = "slugbase/import-boundaries";
export const RAW_IO_RULE = "slugbase/no-raw-io";
export const UNSAFE_HTML_RULE = "slugbase/no-unsafe-html";

const HTTP_GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const ISSUE_LINK = /(?:#\d+|\/issues\/\d+)/;

/** Whether a disable directive's justification ("-- reason") names an issue. */
export function hasIssueLink(justification: string): boolean {
  return ISSUE_LINK.test(justification);
}

function relativeFile(context: Rule.RuleContext): string | undefined {
  return governedPath(context.filename);
}

function governedPath(filename: string): string | undefined {
  const rel = repoPath(filename);
  return rel !== undefined && locate(rel).area !== "other" ? rel : undefined;
}

// `/* eslint slugbase/no-unsafe-html: "off" */` switches the rule off for the
// file before it runs, so no rule can see it; the suppression processor scans
// the text instead. Every inline configuration of the rule needs an issue link
// after " -- ", whatever severity it sets.
const CONFIG_COMMENT = /\/\*\s*eslint\s([\s\S]*?)\*\//g;

export function unsafeHtmlConfigComments(text: string, filename: string): { line: number; column: number }[] {
  if (governedPath(filename) === undefined) {
    return [];
  }
  const found: { line: number; column: number }[] = [];
  for (const match of text.matchAll(CONFIG_COMMENT)) {
    const [rules = "", ...description] = (match[1] ?? "").split(/\s--\s/);
    if (!rules.includes(UNSAFE_HTML_RULE) || hasIssueLink(description.join(" -- "))) {
      continue;
    }
    const before = text.slice(0, match.index).split("\n");
    found.push({ line: before.length, column: (before.at(-1)?.length ?? 0) + 1 });
  }
  return found;
}

// Unwraps what does not change the value an expression evaluates to.
function unwrap(node: { type: string }): { type: string } {
  let current = node as { type: string; expression?: { type: string } };
  while (
    current.expression !== undefined &&
    (current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "ChainExpression")
  ) {
    current = current.expression;
  }
  return current;
}

function globalObjectName(node: { type: string }): string | undefined {
  const inner = unwrap(node) as { type: string; name?: string };
  return inner.type === "Identifier" && inner.name !== undefined && HTTP_GLOBAL_OBJECTS.has(inner.name)
    ? inner.name
    : undefined;
}

function propertyKeyName(property: { computed?: boolean; key: { type: string; name?: string; value?: unknown } }): unknown {
  const { key } = property;
  if (key.type === "Literal") {
    return key.value;
  }
  return key.type === "Identifier" && property.computed !== true ? key.name : undefined;
}

interface SourceNode {
  type: string;
  loc?: Rule.Node["loc"];
}

interface ModuleNode extends SourceNode {
  source?: { type: string; value?: unknown } | null;
}

const importBoundaries: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: { banned: "{{ text }}" } },
  create(context) {
    const rel = relativeFile(context);
    if (rel === undefined) {
      return {};
    }
    const check = (node: SourceNode, specifier: unknown): void => {
      if (typeof specifier !== "string") {
        return;
      }
      const text = checkImport(rel, specifier);
      if (text !== undefined) {
        context.report({ node, messageId: "banned", data: { text } });
      }
    };
    const fromSource = (node: ModuleNode): void => {
      if (node.source != null) {
        check(node, node.source.value);
      }
    };
    return {
      ImportDeclaration: (node) => {
        check(node, node.source.value);
      },
      ExportNamedDeclaration: (node) => {
        fromSource(node);
      },
      ExportAllDeclaration: (node) => {
        check(node, node.source.value);
      },
      ImportExpression: (node) => {
        const { source } = node;
        if (source.type === "Literal") {
          check(node, source.value);
        }
      },
      CallExpression: (node) => {
        const [first] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          first?.type === "Literal"
        ) {
          check(node, first.value);
        }
      },
      // `import x = require("m")` and `import("m")` in a type position.
      TSExternalModuleReference: (node: unknown) => {
        const { expression } = node as { expression: { type: string; value?: unknown } };
        if (expression.type === "Literal") {
          check(node as SourceNode, expression.value);
        }
      },
      TSImportType: (node: unknown) => {
        const { source } = node as { source?: { type: string; literal?: { value?: unknown }; value?: unknown } };
        check(node as SourceNode, source?.literal?.value ?? source?.value);
      },
    };
  },
};

const DB_FACTORIES = new Set(["drizzle", "postgres"]);

const noRawIo: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: { raw: "{{ text }}" } },
  create(context) {
    const rel = relativeFile(context);
    if (rel === undefined) {
      return {};
    }
    const fetchText =
      "fetch is allowed only inside packages/adapters/src/egress/: every outbound request goes through the egress adapter (doc 01 section 10, T6).";
    const dbText =
      "A database handle is created only inside packages/db: tenant queries go through withTenant() (doc 01 section 5.3, T1).";
    const checkFetch = !inEgressDir(rel);
    const checkDb = !inDbPackage(rel);

    const checkDestructuring = (pattern: { type: string }, source: { type: string }): void => {
      if (!checkFetch || pattern.type !== "ObjectPattern" || globalObjectName(source) === undefined) {
        return;
      }
      for (const property of (pattern as unknown as { properties: { type: string; computed?: boolean; key: { type: string; name?: string; value?: unknown } }[] }).properties) {
        if (property.type === "Property" && propertyKeyName(property) === "fetch") {
          context.report({ node: property as unknown as Rule.Node, messageId: "raw", data: { text: fetchText } });
        }
      }
    };

    return {
      Program(program) {
        if (!checkFetch) {
          return;
        }
        const globalScope = context.sourceCode.getScope(program);
        // The global `fetch` is either unresolved or an implicit lib variable.
        const implicit: Scope.Variable | undefined = globalScope.set.get("fetch");
        const references =
          implicit !== undefined && implicit.defs.length > 0 ? [] : (implicit?.references ?? []);
        for (const reference of [...globalScope.through, ...references]) {
          if (reference.identifier.name === "fetch") {
            context.report({ node: reference.identifier, messageId: "raw", data: { text: fetchText } });
          }
        }
      },
      MemberExpression(node) {
        if (!checkFetch || globalObjectName(node.object) === undefined) {
          return;
        }
        const { property } = node;
        const name = node.computed
          ? property.type === "Literal"
            ? property.value
            : undefined
          : property.type === "Identifier"
            ? property.name
            : undefined;
        if (name === "fetch") {
          context.report({ node, messageId: "raw", data: { text: fetchText } });
        }
      },
      // `const { fetch } = globalThis` takes the global fetch without a member access.
      VariableDeclarator(node) {
        if (node.init != null) {
          checkDestructuring(node.id, node.init);
        }
      },
      AssignmentExpression(node) {
        checkDestructuring(node.left, node.right);
      },
      AssignmentPattern(node) {
        checkDestructuring(node.left, node.right);
      },
      CallExpression(node) {
        if (checkDb && node.callee.type === "Identifier" && DB_FACTORIES.has(node.callee.name)) {
          context.report({ node, messageId: "raw", data: { text: dbText } });
        }
      },
    };
  },
};

const UNSAFE_HTML_NAMES = new Set(["dangerouslySetInnerHTML", "innerHTML"]);

const noUnsafeHtml: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      html: `Unsanitised HTML ("{{ name }}") is not rendered (doc 10, T14). A disable comment is accepted only with an issue link after " -- ", such as "#123".`,
    },
  },
  create(context) {
    if (relativeFile(context) === undefined) {
      return {};
    }
    const report = (node: Rule.Node, name: string): void => {
      context.report({ node, messageId: "html", data: { name } });
    };
    const checkName = (node: Rule.Node): void => {
      const { name } = node as unknown as { name: string };
      if (UNSAFE_HTML_NAMES.has(name)) {
        report(node, name);
      }
    };
    return {
      Identifier: checkName,
      JSXIdentifier: checkName,
      Literal(node) {
        if (typeof node.value === "string" && UNSAFE_HTML_NAMES.has(node.value)) {
          report(node, node.value);
        }
      },
    };
  },
};

export const boundaryRules: Record<string, Rule.RuleModule> = {
  "import-boundaries": importBoundaries,
  "no-raw-io": noRawIo,
  "no-unsafe-html": noUnsafeHtml,
};
