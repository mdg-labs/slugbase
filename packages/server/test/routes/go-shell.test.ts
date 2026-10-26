import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { webShell } from "../../src/routes/go/shell.ts";

// The page `/go/<slug>` answers with when the browser has to be shown one: the SPA's index.html of the web root, read only from inside that root.

const base = mkdtempSync(join(tmpdir(), "slugbase-go-shell-root-"));

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function root(name: string): string {
  const path = join(base, name);
  mkdirSync(path);
  return path;
}

describe("webShell", () => {
  it("has no shell for a composition without a web build", () => {
    expect(webShell(undefined)).toBeUndefined();
  });

  it("reads the index.html of the web root each time it is asked, so a new build is served without a restart", async () => {
    const path = root("plain");
    writeFileSync(join(path, "index.html"), "one");
    const shell = webShell(path);

    expect(Buffer.from((await shell?.()) ?? []).toString()).toBe("one");
    writeFileSync(join(path, "index.html"), "two");
    expect(Buffer.from((await shell?.()) ?? []).toString()).toBe("two");
  });

  it("has nothing to answer when the web root has no index.html or is gone", async () => {
    const empty = root("empty");

    expect(await webShell(empty)?.()).toBeUndefined();
    expect(await webShell(join(base, "never-made"))?.()).toBeUndefined();
  });

  it("does not read an index.html that is a link to a file outside the web root", async () => {
    const outside = join(base, "secret.html");
    writeFileSync(outside, "secret");
    const path = root("linked");
    symlinkSync(outside, join(path, "index.html"));

    expect(await webShell(path)?.()).toBeUndefined();
  });
});
