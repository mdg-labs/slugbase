import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFrontmatter,
  validateDocsPublic,
} from "./validate-docs-public.mjs";

/** @type {string[]} */
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {Record<string, string>} files relative path -> content
 */
function makeFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "docs-public-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

const BASE_DOCUMENTATION_JSON = {
  name: "Test Docs",
  navigation: {
    products: [
      {
        product: "Self-hosted",
        tabs: [
          {
            tab: "Guides",
            groups: [
              {
                group: "Intro",
                pages: [{ title: "Introduction", path: "selfhosted/introduction" }],
              },
            ],
          },
        ],
      },
    ],
  },
};

describe("parseFrontmatter", () => {
  it("reads title and description", () => {
    const content = `---
title: "Hello"
description: "World"
---

## Body
`;
    expect(parseFrontmatter(content)).toEqual({
      title: "Hello",
      description: "World",
    });
  });
});

describe("validateDocsPublic", () => {
  it("passes on the current docs/public scaffold tree", async () => {
    const scaffoldRoot = join(
      import.meta.dirname,
      "../docs/public",
    );
    const result = validateDocsPublic(scaffoldRoot);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails when a documentation.json path does not resolve to an MDX file", () => {
    const root = makeFixture({
      "documentation.json": JSON.stringify(BASE_DOCUMENTATION_JSON),
    });

    const result = validateDocsPublic(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      'documentation.json path "selfhosted/introduction" does not resolve to selfhosted/introduction.mdx',
    );
  });

  it("passes when navigation paths and frontmatter are valid", () => {
    const root = makeFixture({
      "documentation.json": JSON.stringify(BASE_DOCUMENTATION_JSON),
      "selfhosted/introduction.mdx": `---
title: "Introduction"
description: "Intro page"
---

## Welcome
`,
    });

    const result = validateDocsPublic(root);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails on missing frontmatter description", () => {
    const root = makeFixture({
      "documentation.json": JSON.stringify({
        name: "Test Docs",
        navigation: { products: [] },
      }),
      "guides/page-one.mdx": `---
title: "Page one"
---

## Body
`,
    });

    const result = validateDocsPublic(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("missing frontmatter description"))).toBe(
      true,
    );
  });

  it("fails on invalid documentation.json", () => {
    const root = makeFixture({
      "documentation.json": "{ not-json",
    });

    const result = validateDocsPublic(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("not valid JSON"))).toBe(true);
  });

  it("fails on non-lowercase-hyphen MDX filenames", () => {
    const root = makeFixture({
      "documentation.json": JSON.stringify({
        name: "Test Docs",
        navigation: {
          products: [
            {
              product: "Self-hosted",
              tabs: [
                {
                  tab: "Guides",
                  groups: [
                    {
                      group: "Intro",
                      pages: [{ title: "Bad", path: "selfhosted/BadName" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      "selfhosted/BadName.mdx": `---
title: "Bad"
description: "Bad filename"
---
`,
    });

    const result = validateDocsPublic(root);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("lowercase-with-hyphens"))).toBe(true);
  });
});
