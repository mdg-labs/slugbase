import type { Rule, Scope } from "eslint";
import {
  checkImport,
  DYNAMIC_LOADER,
  inDbPackage,
  inEgressDir,
  locate,
  networkAccessAllowed,
  repoPath,
  SOCKET_GLOBALS,
} from "./policy.ts";

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

// `/* eslint slugbase/no-raw-io: "off" */` switches a rule off for the file
// before it runs, so no rule can see it; the suppression processor scans the
// text instead. Every inline configuration of a rule in INLINE_GUARDED needs an
// issue link after " -- ", whatever severity it sets.
const CONFIG_COMMENT = /\/\*\s*eslint\s([\s\S]*?)\*\//g;

// The rules that no directive may switch off without an issue link: the
// import boundaries and raw I/O (T1, T6) and unsanitised HTML (T14).
export const ISSUE_LINK_RULES: readonly string[] = [IMPORT_RULE, RAW_IO_RULE, UNSAFE_HTML_RULE];

export function guardedConfigComments(
  text: string,
  filename: string,
): { rule: string; line: number; column: number }[] {
  if (governedPath(filename) === undefined) {
    return [];
  }
  const found: { rule: string; line: number; column: number }[] = [];
  for (const match of text.matchAll(CONFIG_COMMENT)) {
    const [rules = "", ...description] = (match[1] ?? "").split(/\s--\s/);
    if (hasIssueLink(description.join(" -- "))) {
      continue;
    }
    const before = text.slice(0, match.index).split("\n");
    for (const rule of ISSUE_LINK_RULES) {
      if (rules.includes(rule)) {
        found.push({ rule, line: before.length, column: (before.at(-1)?.length ?? 0) + 1 });
      }
    }
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

// A module specifier known without evaluating anything: a string literal, or a
// template literal with no substitutions.
function staticSpecifier(node: {
  type: string;
  value?: unknown;
  expressions?: unknown[];
  quasis?: { value: { cooked?: string | null } }[];
}): unknown {
  if (node.type === "Literal") {
    return node.value;
  }
  return node.type === "TemplateLiteral" && node.expressions?.length === 0 ? node.quasis?.[0]?.value.cooked : undefined;
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
        check(node, staticSpecifier(node.source));
      },
      CallExpression: (node) => {
        const [first] = node.arguments;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          first !== undefined
        ) {
          check(node, staticSpecifier(first));
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
    const checkDb = !inDbPackage(rel);

    // The globals that open a connection, with the message for each. fetch is
    // allowed only in the egress folder; the others also in test and
    // development code.
    const guarded = new Map<string, string>();
    if (!inEgressDir(rel)) {
      guarded.set("fetch", fetchText);
    }
    for (const name of SOCKET_GLOBALS) {
      if (!networkAccessAllowed(rel, name)) {
        guarded.set(name, `${name} opens a connection: connections are made only inside packages/adapters/src/egress/ (doc 01 section 10, T6).`);
      }
    }
    const loaderText = `${DYNAMIC_LOADER} loads any built-in module by name, so the import rules cannot see it: it is not used outside packages/adapters/src/egress/ and test code (doc 01 section 10, T6).`;
    const checkLoader = !networkAccessAllowed(rel, DYNAMIC_LOADER);

    const reportGlobal = (node: Rule.Node, name: unknown): void => {
      const text = typeof name === "string" ? guarded.get(name) : undefined;
      if (text !== undefined) {
        context.report({ node, messageId: "raw", data: { text } });
      }
    };

    const checkDestructuring = (pattern: { type: string }, source: { type: string }): void => {
      if (guarded.size === 0 || pattern.type !== "ObjectPattern" || globalObjectName(source) === undefined) {
        return;
      }
      for (const property of (pattern as unknown as { properties: { type: string; computed?: boolean; key: { type: string; name?: string; value?: unknown } }[] }).properties) {
        if (property.type === "Property") {
          reportGlobal(property as unknown as Rule.Node, propertyKeyName(property));
        }
      }
    };

    const reportLoader = (node: Rule.Node): void => {
      if (checkLoader) {
        context.report({ node, messageId: "raw", data: { text: loaderText } });
      }
    };

    return {
      Program(program) {
        if (guarded.size === 0) {
          return;
        }
        const globalScope = context.sourceCode.getScope(program);
        for (const name of guarded.keys()) {
          // The global is either unresolved or an implicit lib variable.
          const implicit: Scope.Variable | undefined = globalScope.set.get(name);
          const references =
            implicit !== undefined && implicit.defs.length > 0 ? [] : (implicit?.references ?? []);
          for (const reference of [...globalScope.through, ...references]) {
            if (reference.identifier.name === name) {
              reportGlobal(reference.identifier as Rule.Node, name);
            }
          }
        }
      },
      MemberExpression(node) {
        if (guarded.size === 0 || globalObjectName(node.object) === undefined) {
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
        reportGlobal(node, name);
      },
      // `const { fetch } = globalThis` takes the global without a member access.
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
      // The loader by any spelling: process.getBuiltinModule, a destructured
      // name, process["getBuiltinModule"], process[`getBuiltinModule`].
      Identifier(node) {
        if (node.name === DYNAMIC_LOADER) {
          reportLoader(node);
        }
      },
      Literal(node) {
        if (node.value === DYNAMIC_LOADER) {
          reportLoader(node);
        }
      },
      TemplateLiteral(node) {
        if (staticSpecifier(node) === DYNAMIC_LOADER) {
          reportLoader(node);
        }
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
