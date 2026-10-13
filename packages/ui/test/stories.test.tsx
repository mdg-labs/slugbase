import { act, render } from "@testing-library/react";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import * as components from "../src/index.ts";
import * as patterns from "../src/patterns/index.ts";
import {
  exportsWithoutStory,
  listStoryFiles,
  STORY_SUFFIX,
  storiesWithInvalidSubject,
  type StoryFile,
} from "./story-coverage.ts";
import { expectNoViolations, stubBrowserApis, stubCookieStore, stubMatchMedia } from "./support.tsx";

// What `@slugbase/ui` and `@slugbase/ui/patterns` export; each needs a story about it.
const entry = { ...components, ...patterns };

const STORIES_DIR = resolve(import.meta.dirname, "../stories");

const storyFiles = listStoryFiles(STORIES_DIR);

type StoryModule = Record<string, unknown>;

interface LadleConfig {
  stories: string;
  addons: { a11y: { enabled: boolean }; theme: { enabled: boolean } };
}

const { default: ladleConfig } = (await import(resolve(import.meta.dirname, "../.ladle/config.mjs"))) as {
  default: LadleConfig;
};

const storyModules = await Promise.all(
  storyFiles.map(async (name) => [name, (await import(resolve(STORIES_DIR, name))) as StoryModule] as const),
);

describe("Ladle workshop", () => {
  it("enables the accessibility addon and the theme toolbar for every story", () => {
    expect(ladleConfig.addons.a11y.enabled).toBe(true);
    expect(ladleConfig.addons.theme.enabled).toBe(true);
    expect(ladleConfig.stories).toBe(`stories/**/*${STORY_SUFFIX}`);
  });

  it("keeps Ladle and the stories out of what the package publishes", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      files: string[];
    };
    expect(Object.keys(manifest.devDependencies)).toContain("@ladle/react");
    expect(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })).not.toContain("@ladle/react");
    expect(manifest.files).toEqual(["dist", "src/styles"]);
  });

  it("has a story file for the package", () => {
    expect(storyFiles.length).toBeGreaterThan(0);
  });
});

describe("stories", () => {
  beforeEach(() => {
    stubBrowserApis();
    stubMatchMedia(false);
    stubCookieStore();
  });

  describe.each(storyModules)("%s", (_name, module) => {
    const stories = Object.entries(module).filter(([name]) => name !== "default");

    it("exports stories only", () => {
      expect(stories.length).toBeGreaterThan(0);
      for (const [, story] of stories) {
        expect(story).toBeTypeOf("function");
      }
    });

    it.each(stories)("%s renders without accessibility violations", { timeout: HEAVY_TEST_TIMEOUT_MS }, async (_story, story) => {
      const Story = story as () => React.ReactElement;
      const { baseElement, container } = render(<Story />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.childElementCount).toBeGreaterThan(0);
      await expectNoViolations(baseElement);
    });
  });
});

describe("story coverage", () => {
  const stories: StoryFile[] = storyFiles.map((file, index) => {
    const meta = storyModules[index]?.[1].default as { parameters?: { subject?: unknown } } | undefined;
    const subject = meta?.parameters?.subject;
    return {
      file,
      subject: Array.isArray(subject) ? subject.filter((name): name is string => typeof name === "string") : [],
      source: readFileSync(resolve(STORIES_DIR, file), "utf8"),
    };
  });

  it("counts the exports of the patterns subpath with those of the package entry", () => {
    expect(Object.keys(entry)).toEqual(expect.arrayContaining(["Button", "AppShell", "EmptyState", "Loading", "ThemeToggle"]));
  });

  it("has a story about every exported component and pattern", () => {
    expect(exportsWithoutStory({ ...entry }, stories)).toEqual([]);
  });

  it("declares a subject that is an exported component the story uses, in every story file", () => {
    expect(storiesWithInvalidSubject({ ...entry }, stories)).toEqual([]);
  });

  it("names a component whose own story file is gone, though other stories still use it", () => {
    const withoutButton = stories.filter(({ file }) => file !== "button.stories.tsx");

    expect(withoutButton.some(({ source }) => source.includes("<Button"))).toBe(true);
    expect(exportsWithoutStory({ ...entry }, withoutButton)).toEqual(["Button"]);
  });

  it("covers a pattern exported later only through a story that declares it", () => {
    const Pattern = (): null => null;
    const exported = { ...entry, FuturePattern: Pattern, FuturePatternAlias: Pattern, futurePatternHelper: Pattern };
    const patternStory = { file: "patterns/future-pattern.stories.tsx", subject: ["FuturePatternAlias"], source: "export const Shell = () => <FuturePatternAlias />;" };

    expect(exportsWithoutStory(exported, stories)).toEqual(["FuturePattern/FuturePatternAlias"]);
    expect(exportsWithoutStory(exported, [...stories, patternStory])).toEqual([]);
    expect(exportsWithoutStory(exported, [...stories, { ...patternStory, subject: [] }])).toEqual(["FuturePattern/FuturePatternAlias"]);
  });

  it("does not count an import as use", () => {
    const imported = { file: "p.stories.tsx", subject: ["Pattern"], source: 'import { Pattern } from "../src/index.ts";' };

    expect(exportsWithoutStory({ Pattern: () => null }, [imported])).toEqual(["Pattern"]);
    expect(storiesWithInvalidSubject({ Pattern: () => null }, [imported])).toEqual(["p.stories.tsx"]);
  });

  it("flags a story file without a subject or with one that is not a component", () => {
    const source = "export const A = () => <Button />;";

    expect(storiesWithInvalidSubject({ ...entry }, [{ file: "a", subject: [], source }])).toEqual(["a"]);
    expect(storiesWithInvalidSubject({ ...entry }, [{ file: "a", subject: ["cn"], source: "cn()" }])).toEqual(["a"]);
  });
});

describe("nested story files", () => {
  const fixtureRoot = mkdtempSync(resolve(import.meta.dirname, ".nested-stories-"));
  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const write = (name: string, body: string): void => {
    mkdirSync(dirname(resolve(fixtureRoot, name)), { recursive: true });
    writeFileSync(resolve(fixtureRoot, name), body);
  };

  it("are listed, as Ladle's stories/** glob lists them", () => {
    write("top.stories.tsx", "export const A = () => null;");
    write("patterns/deep/nested.stories.tsx", "export const B = () => null;");
    write("patterns/notes.tsx", "export const C = () => null;");

    expect(listStoryFiles(fixtureRoot)).toEqual(["patterns/deep/nested.stories.tsx", "top.stories.tsx"]);
  });

  it("fail the accessibility check when a story has a violation", { timeout: HEAVY_TEST_TIMEOUT_MS }, async () => {
    write("patterns/bad.stories.tsx", 'export const Bad = () => <img src="/x.png" />;');
    stubBrowserApis();

    const files = listStoryFiles(fixtureRoot);
    expect(files).toContain("patterns/bad.stories.tsx");
    const module = (await import(resolve(fixtureRoot, "patterns/bad.stories.tsx"))) as { Bad: () => React.ReactElement };
    const { baseElement } = render(<module.Bad />);

    await expect(expectNoViolations(baseElement)).rejects.toThrow();
  });
});
