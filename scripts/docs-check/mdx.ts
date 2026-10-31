import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * The JSX components a page may use. The site that builds the content renders
 * exactly these (doc 09 section 3.5), so it mirrors this list; any other
 * element, including every HTML tag, is refused.
 */
export const ALLOWED_COMPONENTS = ["Callout", "Tabs", "Tab", "Steps", "Step", "EditionBadge", "Screenshot"] as const;

export interface Finding {
  /** 1-based line within the text that was parsed. */
  line: number;
  message: string;
}

export interface Attribute {
  type: string;
  name?: string;
  value?: string | null | { type: string; value: string };
}

export interface AstNode {
  type: string;
  position?: { start: { line: number; offset?: number }; end: { offset?: number } };
  children?: AstNode[];
  name?: string | null;
  attributes?: Attribute[];
  /** A link, an image or a definition. */
  url?: string;
  /** A definition. */
  identifier?: string;
  /** A reference to a definition. */
  referenceType?: string;
  /** Text, inline code and code. */
  value?: string;
  /** A heading. */
  depth?: number;
}

// Both parsers read GFM, as the site that renders the pages does: a bare
// address in the text becomes a link there, so it is a link here.
const markdownParser = unified().use(remarkParse).use(remarkGfm);
const mdxParser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

// What `{...}` may hold in an attribute: one number or boolean literal.
const LITERAL = /^(?:true|false|-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/;

function parseFailure(error: unknown): Finding {
  if (error instanceof Error) {
    const line = "line" in error && typeof error.line === "number" ? error.line : 1;
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : error.message;
    return { line, message: `not valid MDX: ${reason}` };
  }
  return { line: 1, message: "not valid MDX" };
}

function checkAttributes(node: AstNode, line: number, findings: Finding[]): void {
  for (const attribute of node.attributes ?? []) {
    if (attribute.type === "mdxJsxExpressionAttribute") {
      findings.push({ line, message: "a spread attribute is not allowed; write attributes as name=\"value\"" });
      continue;
    }
    const value = attribute.value;
    if (typeof value === "object" && value !== null && !LITERAL.test(value.value.trim())) {
      findings.push({
        line,
        message: `the value of attribute "${attribute.name ?? ""}" is a JavaScript expression; use a string, number or boolean literal`,
      });
    }
  }
}

function inspect(node: AstNode, findings: Finding[]): void {
  const line = node.position?.start.line ?? 1;
  switch (node.type) {
    case "mdxjsEsm":
      findings.push({ line, message: "import and export statements are not allowed" });
      break;
    case "mdxFlowExpression":
    case "mdxTextExpression":
      findings.push({ line, message: "a JavaScript expression in the text is not allowed" });
      break;
    case "html":
      findings.push({ line, message: "raw HTML is not allowed; use Markdown syntax for links and images" });
      break;
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement": {
      const name = node.name ?? null;
      if (name === null || !(ALLOWED_COMPONENTS as readonly (string | null)[]).includes(name)) {
        findings.push({
          line,
          message: `${name === null ? "a fragment" : `<${name}>`} is not an allowed component (allowed: ${ALLOWED_COMPONENTS.join(", ")})`,
        });
      }
      checkAttributes(node, line, findings);
      break;
    }
    default:
      break;
  }
  for (const child of node.children ?? []) inspect(child, findings);
}

export type Parsed = { ok: true; tree: AstNode } | { ok: false; finding: Finding };

/**
 * Parses a page body (the page without its frontmatter) as MDX for a `.mdx`
 * file and as Markdown, never as MDX, for a `.md` file (doc 09 section 3.5).
 */
export function parseBody(body: string, extension: ".md" | ".mdx"): Parsed {
  try {
    return { ok: true, tree: (extension === ".mdx" ? mdxParser : markdownParser).parse(body) };
  } catch (error) {
    return { ok: false, finding: parseFailure(error) };
  }
}

/**
 * Returns what the contract refuses in a parsed page. Code fences and inline
 * code are not parsed as MDX, so they may hold any text. A Markdown file is not
 * scanned for `import`, `export` or `{...}`: the contract has the site compile
 * a `.md` file as plain Markdown, which gives them no meaning, so only raw HTML
 * is refused there.
 */
export function lintTree(tree: AstNode): Finding[] {
  const findings: Finding[] = [];
  inspect(tree, findings);
  // A raw HTML element is an opening and a closing node; report it once per line.
  return findings.filter(
    (finding, index) => findings.findIndex((other) => other.line === finding.line && other.message === finding.message) === index,
  );
}

export function lintBody(body: string, extension: ".md" | ".mdx"): Finding[] {
  const parsed = parseBody(body, extension);
  return parsed.ok ? lintTree(parsed.tree) : [parsed.finding];
}
