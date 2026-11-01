import { parseDocument } from "yaml";
import { z } from "zod";

const NUMERIC = String.raw`(?:0|[1-9]\d*)`;
const PRERELEASE_ID = String.raw`(?:${NUMERIC}|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const VERSION = new RegExp(
  String.raw`^${NUMERIC}\.${NUMERIC}\.${NUMERIC}(?:-${PRERELEASE_ID}(?:\.${PRERELEASE_ID})*)?$`,
);

/** A version as the docs contract writes it: `1.0.0` or `1.2.0-rc.1`. */
export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

const nonEmpty = z.string().refine((value) => value.trim() !== "", { message: "must not be empty" });

export const EDITIONS = ["ce", "cloud", "both"] as const;

export const frontmatterSchema = z.strictObject({
  title: nonEmpty,
  description: nonEmpty,
  edition: z.enum(EDITIONS),
  since: z.string().refine(isVersion, { message: "must be a version such as 1.0.0 or 1.2.0-rc.1" }).optional(),
  order: z.number().int().optional(),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface SplitPage {
  /** The YAML between the two `---` lines. */
  yaml: string;
  /** The page without its frontmatter block. */
  body: string;
  /** The number of lines the frontmatter block takes, including both `---` lines. */
  frontmatterLines: number;
}

const BLOCK = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Splits the frontmatter block off a page; null when the page does not start with one. */
export function splitFrontmatter(text: string): SplitPage | null {
  const source = stripBom(text);
  const match = BLOCK.exec(source);
  if (match === null) return null;
  const block = match[0];
  return {
    yaml: match[1] ?? "",
    body: source.slice(block.length),
    frontmatterLines: block.split("\n").length - 1,
  };
}

export type FrontmatterResult = { ok: true; data: Frontmatter } | { ok: false; problems: string[] };

export function validateFrontmatter(yamlText: string): FrontmatterResult {
  const document = parseDocument(yamlText, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((error) => `frontmatter is not valid YAML: ${error.message.split("\n")[0] ?? error.message}`),
    };
  }
  const value: unknown = document.toJS();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, problems: ["frontmatter must be a mapping of fields"] };
  }
  const parsed = frontmatterSchema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      if (issue.code === "unrecognized_keys") {
        return `frontmatter: unknown field ${issue.keys.map((key) => `"${key}"`).join(", ")}`;
      }
      const field = issue.path.map(String).join(".");
      return `frontmatter field "${field}": ${issue.message}`;
    }),
  };
}
