import ts from "typescript";

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const HTTP_MODULES = new Set(["node:http", "node:https", "node:http2", "http", "https", "http2", "undici"]);

/** Strips the wrappers that leave an expression's value unchanged: parentheses, assertions, `!`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isGlobalFetch(callee: ts.Expression): boolean {
  const target = unwrap(callee);
  if (ts.isIdentifier(target)) {
    return target.text === "fetch";
  }
  let object: ts.Expression;
  let member: string | undefined;
  if (ts.isPropertyAccessExpression(target)) {
    object = target.expression;
    member = target.name.text;
  } else if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    object = target.expression;
    member = target.argumentExpression.text;
  } else {
    return false;
  }
  const owner = unwrap(object);
  return member === "fetch" && ts.isIdentifier(owner) && GLOBAL_OBJECTS.has(owner.text);
}

/** Whether `node` sits where it is called: the callee of a call, through any value-preserving wrapper. */
function isCallee(node: ts.Expression): boolean {
  let current: ts.Node = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isCallExpression(current.parent) && current.parent.expression === current;
}

/**
 * Whether an identifier named `fetch` reads a value: not a declared name, a member
 * or property name, an import or export name, or part of a type.
 */
function isValueReference(node: ts.Identifier): boolean {
  const { parent } = node;
  if (ts.isShorthandPropertyAssignment(parent)) {
    return true;
  }
  const named = parent as { name?: ts.Node; propertyName?: ts.Node };
  if (named.name === node || named.propertyName === node) {
    return false;
  }
  return !(ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent));
}

function httpModule(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) && HTTP_MODULES.has(node.text) ? node.text : undefined;
}

/**
 * The outbound-request forms in a TypeScript source that only the egress adapter may
 * hold (doc 01 section 6, T6): a call of the global `fetch` bare or through
 * `globalThis`, `window`, `self` or `global`, any other read of it (`const send =
 * fetch`, `{ fetch }` handed to a client), and any reach for a Node HTTP module or
 * undici (static import, re-export, `import()`, `require()`, `import x = require()`).
 *
 * It reads the syntax tree, so `app.fetch(request)`, a `fetch(request: Request)`
 * method declaration, and the word in a comment or string are not matches. A local
 * variable named `fetch` that is read does match: the sweep over-reports rather
 * than miss a call.
 */
export function findRawOutbound(source: string, fileName = "source.ts"): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    const where = String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    const readsFetch =
      ts.isIdentifier(node)
        ? node.text === "fetch" && isValueReference(node)
        : (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isGlobalFetch(node);
    if (readsFetch) {
      const expression = node as ts.Expression;
      found.push(`line ${where}: ${isCallee(expression) ? "call of" : "reference to"} the global fetch`);
    }
    if (ts.isCallExpression(node)) {
      const isLoader =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      const loaded = isLoader ? httpModule(node.arguments[0]) : undefined;
      if (loaded !== undefined) {
        found.push(`line ${where}: loads ${loaded}`);
      }
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const imported = httpModule(node.moduleSpecifier);
      if (imported !== undefined) {
        found.push(`line ${where}: imports ${imported}`);
      }
    } else if (ts.isExternalModuleReference(node)) {
      const imported = httpModule(node.expression);
      if (imported !== undefined) {
        found.push(`line ${where}: imports ${imported}`);
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const imported = httpModule(node.argument.literal);
      if (imported !== undefined) {
        found.push(`line ${where}: imports ${imported}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
