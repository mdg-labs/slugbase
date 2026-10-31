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

interface Attribute {
  type: string;
  name?: string;
  value?: string | null | { type: string; value: string };
}

interface AstNode {
  type: string;
  position?: { start: { line: number } };
  children?: AstNode[];
  name?: string | null;
  attributes?: Attribute[];
}

const markdownParser = unified().use(remarkParse);
const mdxParser = unified().use(remarkParse).use(remarkMdx);

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

/**
 * Parses a page body (the page without its frontmatter) as MDX for a `.mdx`
 * file and as Markdown for a `.md` file, and returns what the contract refuses.
 * Code fences and inline code are not parsed as MDX, so they may hold any text.
 * A Markdown file is not scanned for `import`, `export` or `{...}`: Markdown
 * gives them no meaning, only raw HTML is refused there.
 */
export function lintBody(body: string, extension: ".md" | ".mdx"): Finding[] {
  const findings: Finding[] = [];
  let tree: AstNode;
  try {
    tree = (extension === ".mdx" ? mdxParser : markdownParser).parse(body);
  } catch (error) {
    return [parseFailure(error)];
  }
  inspect(tree, findings);
  // A raw HTML element is an opening and a closing node; report it once per line.
  return findings.filter(
    (finding, index) => findings.findIndex((other) => other.line === finding.line && other.message === finding.message) === index,
  );
}
