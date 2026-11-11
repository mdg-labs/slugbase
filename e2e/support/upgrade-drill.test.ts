import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import upgradeConfig from "../upgrade-drill.config.ts";
import type { Snapshot } from "./seed-instance.ts";
import {
  appVersion,
  candidateCommit,
  candidateImage,
  guideCodeLines,
  guideCommands,
  healthOf,
  readBackProblems,
  readGuide,
  RELEASE_CANDIDATE_IMAGE,
  setEnvValue,
  versionProblems,
  type Forwarded,
  type Instance,
} from "./upgrade-drill.ts";

function seededInstance(): Instance {
  const snapshot: Snapshot = {
    bookmarks: [0, 1, 2].map((index) => ({
      id: `id-${String(index)}`,
      url: `https://drill.example.test/page/${String(index)}`,
      title: `Drill page ${String(index)}`,
      slug: index < 2 ? `slug-${String(index)}` : null,
      forwarding: index < 2,
      pinned: index === 0,
      tags: ["alpha"],
      folders: ["Reading"],
    })),
    folders: [{ name: "Reading", bookmarkCount: 3 }],
    tags: [{ name: "alpha", bookmarkCount: 3 }],
  };
  return { snapshot, shares: 1 };
}

function forwards(instance: Instance): Forwarded[] {
  return instance.snapshot.bookmarks.flatMap((bookmark) => (bookmark.slug === null ? [] : [{ slug: bookmark.slug, status: 302, location: bookmark.url }]));
}

void describe("the read-back of the upgraded instance", () => {
  void it("finds nothing to report when the instance is as it was seeded and every slug forwards", () => {
    const seeded = seededInstance();
    assert.deepEqual(readBackProblems(seeded, structuredClone(seeded), forwards(seeded)), []);
  });

  void it("reports a bookmark that is missing, with the count that follows from it", () => {
    const seeded = seededInstance();
    const now = structuredClone(seeded);
    now.snapshot.bookmarks = now.snapshot.bookmarks.filter((bookmark) => bookmark.title !== "Drill page 2");
    const problems = readBackProblems(seeded, now, forwards(seeded));
    assert.ok(problems.includes('the bookmark "Drill page 2" is missing'), problems.join("; "));
    assert.ok(problems.includes("2 bookmarks after the upgrade, 3 seeded"), problems.join("; "));
  });

  void it("reports a bookmark that changed, a folder or tag that holds another number of bookmarks, and a share that is gone", () => {
    const seeded = seededInstance();
    const now = structuredClone(seeded);
    now.snapshot.bookmarks[0] = { ...(now.snapshot.bookmarks[0] as (typeof now.snapshot.bookmarks)[number]), title: "Drill page 0", pinned: false };
    now.snapshot.folders = [{ name: "Reading", bookmarkCount: 2 }];
    now.snapshot.tags = [];
    now.shares = 0;
    const problems = readBackProblems(seeded, now, forwards(seeded));
    assert.ok(problems.includes('the bookmark "Drill page 0" is not as it was seeded'), problems.join("; "));
    assert.ok(problems.includes('the folder "Reading" holds 2 bookmarks, 3 seeded'), problems.join("; "));
    assert.ok(problems.includes('the tag "alpha" is missing'), problems.join("; "));
    assert.ok(problems.includes("0 shares after the upgrade, 1 seeded"), problems.join("; "));
  });

  void it("reports a slug that no longer forwards, one that forwards elsewhere and one that was not tried", () => {
    const seeded = seededInstance();
    const answered = forwards(seeded);
    answered[0] = { slug: "slug-0", status: 404, location: null };
    answered[1] = { slug: "slug-1", status: 302, location: "https://elsewhere.example.test/" };
    const problems = readBackProblems(seeded, structuredClone(seeded), answered);
    assert.ok(problems.includes("/go/slug-0 answered 404 to no address, expected 302 to https://drill.example.test/page/0"), problems.join("; "));
    assert.ok(problems.includes("/go/slug-1 answered 302 to https://elsewhere.example.test/, expected 302 to https://drill.example.test/page/1"), problems.join("; "));
    assert.deepEqual(readBackProblems(seeded, structuredClone(seeded), answered.slice(1)), [
      "/go/slug-0 was not tried",
      "/go/slug-1 answered 302 to https://elsewhere.example.test/, expected 302 to https://drill.example.test/page/1",
    ]);
  });
});

void describe("the answer of /version", () => {
  const expected = { commit: "0123456789abcdef0123456789abcdef01234567", version: "1.0.0" };

  void it("names the image under test when its commit and version are the expected ones", () => {
    assert.deepEqual(versionProblems({ name: "SlugBase", ...expected, builtAt: "2026-11-10T00:00:00Z" }, expected), []);
  });

  void it("is refused when it names another commit, as the release candidate still running would", () => {
    const problems = versionProblems({ name: "SlugBase", commit: "ec223f6c", version: "1.0.0", builtAt: "x" }, expected);
    assert.deepEqual(problems, ['/version names the commit "ec223f6c", expected 0123456789abcdef0123456789abcdef01234567']);
  });

  void it("is refused when it names another version or is no object", () => {
    assert.equal(versionProblems({ commit: expected.commit, version: "0.9.0" }, expected).length, 1);
    assert.deepEqual(versionProblems("down", expected), ["/version did not answer with an object"]);
  });
});

void describe("the guide the drill follows", () => {
  const guide = readGuide();

  void it("holds every command the drill runs, in its code blocks", () => {
    assert.deepEqual(guideCommands(guide), { up: ["up", "-d"], migrate: ["run", "--rm", "slugbase", "migrate"], readyPath: "/ready", versionPath: "/version" });
    assert.ok(guideCodeLines(guide).includes("docker compose pull"));
  });

  void it("reads only the lines between fences, indented or not", () => {
    assert.deepEqual(guideCodeLines("prose docker compose up -d\n\n   ```sh\n   docker compose up -d\n\n   ```\n\nafter\n"), ["docker compose up -d"]);
  });

  for (const command of ["docker compose up -d", "docker compose run --rm slugbase migrate", "docker compose pull", "curl -fsS http://127.0.0.1:3000/ready", "curl -fsS http://127.0.0.1:3000/version"]) {
    void it(`is refused when it lacks ${command}`, () => {
      const lacking = guide
        .split("\n")
        .filter((line) => line.trim() !== command)
        .join("\n");
      assert.notEqual(lacking, guide, "the guide has the line");
      assert.throws(() => guideCommands(lacking), /no longer has what the drill runs/);
    });
  }

  void it("is refused when a command is only in the prose, and when the image setting or the health sentence is gone", () => {
    const unfenced = guide.replace(/^\s*```.*$/gm, "");
    assert.notEqual(unfenced, guide);
    assert.throws(() => guideCommands(unfenced), /docker compose run --rm slugbase migrate/);
    assert.throws(() => guideCommands(guide.replace(/^ *SLUGBASE_IMAGE=.*$/gm, "")), /SLUGBASE_IMAGE=<image>/);
    assert.throws(() => guideCommands(guide.replaceAll("`docker compose ps` shows `slugbase` as healthy", "")), /docker compose ps/);
  });
});

void describe("the images of the drill", () => {
  void it("pins the release candidate by digest, and the image to upgrade to is another one", () => {
    assert.match(RELEASE_CANDIDATE_IMAGE, /^ghcr\.io\/mdg-labs\/slugbase@sha256:[0-9a-f]{64}$/);
    assert.equal(candidateImage({ SLUGBASE_IMAGE: "slugbase:e2e" }), "slugbase:e2e");
    assert.equal(candidateImage({ E2E_IMAGE: "slugbase:e2e" }), "slugbase:e2e");
    assert.throws(() => candidateImage({}), /SLUGBASE_IMAGE is not set/);
    assert.throws(() => candidateImage({ SLUGBASE_IMAGE: RELEASE_CANDIDATE_IMAGE }), /image to upgrade from/);
  });

  void it("needs the commit the image was built from", () => {
    assert.equal(candidateCommit({ BUILD_COMMIT: "0123456789abcdef0123456789abcdef01234567" }), "0123456789abcdef0123456789abcdef01234567");
    assert.throws(() => candidateCommit({}), /BUILD_COMMIT/);
    assert.throws(() => candidateCommit({ BUILD_COMMIT: "unknown" }), /BUILD_COMMIT/);
  });

  void it("reports the version of the app package", () => {
    assert.match(appVersion(), /^\d+\.\d+\.\d+/);
  });
});

void describe("the env file of the stack", () => {
  void it("has a value replaced in place, or added, and keeps its mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "upgrade-drill-test-"));
    try {
      const file = join(dir, "stack.env");
      writeFileSync(file, "A=1\nSLUGBASE_IMAGE=old\nB=2\n", { mode: 0o600 });
      setEnvValue(file, "SLUGBASE_IMAGE", "new");
      setEnvValue(file, "MIGRATE_ON_START", "false");
      assert.equal(readFileSync(file, "utf8"), "A=1\nSLUGBASE_IMAGE=new\nB=2\nMIGRATE_ON_START=false\n");
      assert.equal(statSync(file).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void describe("the health of a service in docker compose ps", () => {
  void it("is read from one object per line and from an array", () => {
    const line = (service: string, health: string): string => JSON.stringify({ Service: service, State: "running", Health: health });
    assert.equal(healthOf([line("slugbase", "starting"), line("postgres", "healthy")].join("\n"), "slugbase"), "starting");
    assert.equal(healthOf(`[${line("slugbase", "healthy")}]`, "slugbase"), "healthy");
    assert.equal(healthOf(JSON.stringify({ Service: "slugbase", State: "exited", Health: "" }), "slugbase"), "exited");
    assert.equal(healthOf("", "slugbase"), undefined);
  });
});

void describe("the configuration of the drill", () => {
  void it("gives a test time for two stacks and keeps the drill out of the journeys' directories", () => {
    assert.ok(upgradeConfig.timeout !== undefined && upgradeConfig.timeout >= 10 * 60_000);
    assert.match(String(upgradeConfig.outputDir), /upgrade-drill/);
  });
});
