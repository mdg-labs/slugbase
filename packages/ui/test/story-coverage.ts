import { readdirSync } from "node:fs";
import { sep } from "node:path";
import ts from "typescript";

export const STORY_SUFFIX = ".stories.tsx";

const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;

/**
 * The names a package entry point exports that are components or patterns: a
 * function under a PascalCase name. Re-exported Base UI primitives (`...Primitive`)
 * are third-party namespaces, not SlugBase components. Names bound to one function
 * (an alias such as `TooltipContent`) form one group, so a story for either covers both.
 */
export function componentExportGroups(entry: Record<string, unknown>): string[][] {
  const groups = new Map<unknown, string[]>();
  for (const [name, value] of Object.entries(entry)) {
    if (typeof value !== "function" || !COMPONENT_NAME.test(name) || name.endsWith("Primitive")) {
      continue;
    }
    groups.set(value, [...(groups.get(value) ?? []), name]);
  }
  return [...groups.values()];
}

/** Every identifier a story source uses outside its import declarations. */
export function usedIdentifiers(source: string): Set<string> {
  const file = ts.createSourceFile("story.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node)) {
      used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return used;
}

/** A story file, the components it declares it is about, and its source. */
export interface StoryFile {
  file: string;
  subject: readonly string[];
  source: string;
}

/** The story files under `dir` (recursively, as Ladle's `stories/**` glob), as sorted relative POSIX paths. */
export function listStoryFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(STORY_SUFFIX))
    .sort();
}

/**
 * The exported component groups with no story of their own, each as its names joined by `/`.
 * A story covers a component only when its file declares the component as its subject and
 * its source uses it, so a component that merely appears inside another component's story is not covered.
 */
export function exportsWithoutStory(entry: Record<string, unknown>, stories: readonly StoryFile[]): string[] {
  const covered = new Set(
    stories.flatMap(({ subject, source }) => {
      const used = usedIdentifiers(source);
      return subject.filter((name) => used.has(name));
    }),
  );
  return componentExportGroups(entry)
    .filter((names) => !names.some((name) => covered.has(name)))
    .map((names) => names.join("/"));
}

/** Story files whose declared subject is empty, names something that is not an exported component, or names a component the file never uses. */
export function storiesWithInvalidSubject(entry: Record<string, unknown>, stories: readonly StoryFile[]): string[] {
  const components = new Set(componentExportGroups(entry).flat());
  return stories
    .filter(({ subject, source }) => {
      const used = usedIdentifiers(source);
      return subject.length === 0 || subject.some((name) => !components.has(name) || !used.has(name));
    })
    .map(({ file }) => file);
}
