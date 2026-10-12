import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEVELOPMENT_BUILD_INFO, loadBuildInfo } from "../src/build-info.ts";

const directory = mkdtempSync(join(tmpdir(), "slugbase-build-info-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function fileWith(name: string, content: string): string {
  const file = join(directory, name);
  writeFileSync(file, content);
  return file;
}

const built = { name: "SlugBase", version: "1.4.2", commit: "0123abc", builtAt: "2026-10-12T08:00:00Z" };

describe("loadBuildInfo", () => {
  it("reads the four members the image build writes", () => {
    expect(loadBuildInfo(fileWith("built.json", JSON.stringify(built)))).toEqual(built);
  });

  it("keeps nothing but those four members", () => {
    const info = loadBuildInfo(fileWith("extra.json", JSON.stringify({ ...built, registryToken: "x", nested: { a: 1 } })));
    expect(Object.keys(info).sort()).toEqual(["builtAt", "commit", "name", "version"]);
  });

  it("reports a development run when there is no file", () => {
    expect(loadBuildInfo(join(directory, "missing.json"))).toEqual(DEVELOPMENT_BUILD_INFO);
    expect(DEVELOPMENT_BUILD_INFO.commit).toBe("development");
  });

  it("refuses a file that exists but cannot be used, rather than falling back", () => {
    mkdirSync(join(directory, "a-directory.json"));
    expect(() => loadBuildInfo(join(directory, "a-directory.json"))).toThrow("cannot be read");
    expect(() => loadBuildInfo(fileWith("broken.json", "{"))).toThrow("not valid JSON");
    expect(() => loadBuildInfo(fileWith("array.json", "[]"))).toThrow("must hold");
    expect(() => loadBuildInfo(fileWith("short.json", JSON.stringify({ name: "SlugBase", version: "1" })))).toThrow("must hold");
    expect(() => loadBuildInfo(fileWith("typed.json", JSON.stringify({ ...built, commit: 7 })))).toThrow("must hold");
  });
});
