import { expect, test } from "@playwright/test";
import { compose, readyOf, Session, shippedMigrations, startDrillStack, STACK_START_MS, waitForReady, type DrillStack } from "./support/restore-drill.ts";
import {
  bookmarksOf,
  record,
  seedInstance,
  shareCountOf,
  signIn,
  signInWithCode,
  snapshotOf,
  text,
  type Seeded,
} from "./support/seed-instance.ts";
import {
  appVersion,
  candidateCommit,
  candidateImage,
  guideCommands,
  hasImage,
  healthOf,
  pullAnonymously,
  readBackProblems,
  readGuide,
  RELEASE_CANDIDATE_IMAGE,
  setEnvValue,
  versionProblems,
  waitForNotReady,
  type Forwarded,
  type GuideCommands,
  type Instance,
} from "./support/upgrade-drill.ts";

// The upgrade drill (doc 08 section 5.1, D25, Q52): it proves docs/self-hosting/upgrade.md on the image of this commit. It starts
// a stack of its own on the published release candidate, ghcr.io/mdg-labs/slugbase:1.0.0-rc.1, pulled anonymously and pinned by
// digest (RELEASE_CANDIDATE_IMAGE), on PostgreSQL 18, and seeds it through the API with the instance the restore drill seeds
// (e2e/support/seed-instance.ts): an owner, a member with an authenticator app, folders, tags, bookmarks with slugs and a
// share. It then follows steps 3 to 5 of the guide's "Upgrade" on the same database: SLUGBASE_IMAGE is set to the image of the
// commit under test in the stack's env file, `docker compose up -d` recreates the server and the worker, and /ready, /version and
// the health of `slugbase` are checked. Step 6 is the read-back: the owner signs in, the counts and every bookmark, folder and tag
// are as seeded, every slug forwards, the member sees the share and signs in with a code (the secret the release candidate
// sealed opens under the candidate), and a bookmark made after the upgrade is saved.
//
// A second variant follows "Run the migration yourself" on a fresh stack of the release candidate: with MIGRATE_ON_START=false
// the server of the commit under test answers /ready 503 with fewer migrations applied than it expects, `docker compose run --rm
// slugbase migrate` exits 0, and /ready then answers 200 and the same read-back passes.
//
// The commands are the guide's: the drill reads docs/self-hosting/upgrade.md and refuses to run unless every command it runs is
// a line of its code blocks. `docker compose pull` is the one step it does not run for the candidate, which was built on the
// runner and is in no registry; the guide has to keep the step. The stack starts from the checkout's compose.yml (the release
// candidate accepts it); an operator on the release candidate would have the compose.yml of its tag, which the drill does not
// need, because the candidate's compose.yml is the one the guide's upgrade ends with.
//
// The stack is the drill's own (e2e/restore-drill-stack.sh, as the restore drill's): it upgrades its database, so it never shares
// one with the journeys. The image of the commit is SLUGBASE_IMAGE (or E2E_IMAGE) and its commit is BUILD_COMMIT, as the jobs
// of e2e.yml set them. Its passwords, keys and codes are made up for the run and are never printed.

/** The PostgreSQL major of the drill's stack: the default of compose.yml, since the chain is proved on both majors elsewhere. */
const POSTGRES_MAJOR = "18";
/** A stack of the release candidate, the seed and the upgrade, each with its waits. */
const DRILL_TEST_MS = STACK_START_MS + 10 * 60_000;
const HEALTHY_SECONDS = 180;

interface Upgrade {
  guide: GuideCommands;
  image: string;
  commit: string;
}

async function answerOf(stack: DrillStack, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, stack.baseUrl), { signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: (await response.json()) as unknown };
}

/** Starts a stack of its own on the release candidate and seeds it; the instance the owner sees is read back before anything changes. */
async function startOnReleaseCandidate(upgrade: Upgrade): Promise<{ stack: DrillStack; seeded: Seeded; before: Instance; releaseCandidate: { commit: string; migrations: number } }> {
  const stack = await startDrillStack({ ...process.env, SLUGBASE_IMAGE: RELEASE_CANDIDATE_IMAGE, SMOKE_POSTGRES_MAJOR: POSTGRES_MAJOR });
  try {
    const seeded = await seedInstance(stack);
    const owner = await signIn(stack, seeded.owner);
    const before = { snapshot: seeded.snapshot, shares: await shareCountOf(owner, seeded.sharedId) };
    expect(before.shares, "the shares of the seeded bookmark").toBe(1);
    expect(
      readBackProblems(before, { snapshot: await snapshotOf(owner), shares: before.shares }, await forwardedBy(owner, seeded.snapshot.bookmarks)),
      "the instance on the release candidate",
    ).toEqual([]);
    const version = record((await answerOf(stack, upgrade.guide.versionPath)).body, "/version");
    const ready = await readyOf(stack.baseUrl);
    expect(typeof ready.applied === "number" ? ready.applied : 0, "the migrations the release candidate applied").toBeGreaterThan(0);
    expect(version.commit, "the release candidate is not the image under test").not.toBe(upgrade.commit);
    return { stack, seeded, before, releaseCandidate: { commit: text(version.commit, "the commit of the release candidate"), migrations: Number(ready.applied) } };
  } catch (error) {
    await stack.finish(false);
    throw error;
  }
}

async function forwardedBy(owner: Session, bookmarks: { slug: string | null }[]): Promise<Forwarded[]> {
  const forwarded: Forwarded[] = [];
  for (const bookmark of bookmarks) {
    if (bookmark.slug !== null) {
      const reply = await owner.get(`/go/${bookmark.slug}`);
      forwarded.push({ slug: bookmark.slug, status: reply.status(), location: reply.headers.get("location") });
    }
  }
  return forwarded;
}

/** Step 3 of the guide: the new version in the env file. */
function setNewImage(stack: DrillStack, image: string): void {
  setEnvValue(stack.envFile, "SLUGBASE_IMAGE", image);
}

/** Step 5 of the guide: ready at the level the checkout ships, on the version of the commit, and `slugbase` healthy. */
async function checkReadyAndVersion(stack: DrillStack, upgrade: Upgrade): Promise<void> {
  await test.step("/ready answers 200 with the expected migrations applied", async () => {
    const ready = await answerOf(stack, upgrade.guide.readyPath);
    expect(ready.status, `GET ${upgrade.guide.readyPath}`).toBe(200);
    const body = record(ready.body, upgrade.guide.readyPath);
    expect(body.database, "the database in /ready").toBe("ok");
    const migrations = record(body.migrations, "the migrations in /ready");
    expect(migrations.expected, "the expected migrations in /ready").toBe(shippedMigrations());
    expect(migrations.applied, "the applied migrations in /ready").toBe(shippedMigrations());
  });

  await test.step("/version names the commit under test and the version of the app", async () => {
    const version = await answerOf(stack, upgrade.guide.versionPath);
    expect(version.status, `GET ${upgrade.guide.versionPath}`).toBe(200);
    expect(versionProblems(version.body, { commit: upgrade.commit, version: appVersion() }), "what /version names").toEqual([]);
  });

  await test.step("docker compose ps shows slugbase as healthy", async () => {
    expect(await healthOfServer(stack), "the health of slugbase").toBe("healthy");
  });
}

/** The health of `slugbase` in `docker compose ps`, once it is healthy or after a wait; Docker re-checks every 10 seconds, so a server that just became ready is still unhealthy for a moment. */
async function healthOfServer(stack: DrillStack): Promise<string | undefined> {
  const deadline = Date.now() + HEALTHY_SECONDS * 1000;
  for (;;) {
    const health = healthOf(compose(stack, ["ps", "--format", "json", "slugbase"]).stdout, "slugbase");
    if (health === "healthy" || Date.now() >= deadline) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Step 6 of the guide: sign in and open a slug, and what that means for the data of the seeded instance. */
async function readBack(stack: DrillStack, seeded: Seeded, before: Instance): Promise<void> {
  const owner = await signIn(stack, seeded.owner);

  await test.step("the counts and every bookmark, folder and tag are as seeded, and every slug forwards", async () => {
    const now = { snapshot: await snapshotOf(owner), shares: await shareCountOf(owner, seeded.sharedId) };
    const problems = readBackProblems(before, now, await forwardedBy(owner, before.snapshot.bookmarks));
    expect(problems, "what differs from the seeded instance").toEqual([]);
  });

  await test.step("the member sees the share and signs in with an authenticator code", async () => {
    const member = await signInWithCode(stack, seeded);
    const shared = await bookmarksOf(member, "shared_with_me");
    expect(
      shared.map((bookmark) => bookmark.id),
      "the bookmarks shared with the member",
    ).toEqual([seeded.sharedId]);
  });

  await test.step("a bookmark made after the upgrade is saved", async () => {
    const slug = `after-${seeded.token}`;
    const created = record(
      await owner.expect("POST", "/api/v1/bookmarks", 201, { url: "https://drill.example.test/after-the-upgrade", title: "After the upgrade", slug }),
      "a bookmark",
    );
    const saved = (await bookmarksOf(owner, "mine")).find((bookmark) => bookmark.id === text(created.id, "a bookmark id"));
    expect(saved?.title, "the bookmark made after the upgrade").toBe("After the upgrade");
    const reply = await owner.get(`/go/${slug}`);
    expect(reply.status(), `GET /go/${slug}`).toBe(302);
    expect(reply.headers.get("location"), `where /go/${slug} forwards`).toBe("https://drill.example.test/after-the-upgrade");
  });
}

test.describe("the upgrade drill", () => {
  let upgrade: Upgrade | undefined;

  test.beforeAll(() => {
    test.setTimeout(STACK_START_MS);
    // Refuses to run on a guide that has lost a command the drill runs, before anything is pulled or started.
    const guide = guideCommands(readGuide());
    const image = candidateImage();
    const commit = candidateCommit();
    if (!hasImage(image)) {
      throw new Error(`the image under test is not present locally: ${image}`);
    }
    pullAnonymously(RELEASE_CANDIDATE_IMAGE);
    upgrade = { guide, image, commit };
  });

  function planned(): Upgrade {
    if (upgrade === undefined) {
      throw new Error("the drill did not start");
    }
    return upgrade;
  }

  test("upgrades the release candidate to the image of this commit by the guide's steps", async () => {
    test.setTimeout(DRILL_TEST_MS);
    const plan = planned();
    const { stack, seeded, before } = await startOnReleaseCandidate(plan);
    let passed = false;
    try {
      await test.step("step 3: the new image is set in the env file, and step 4: docker compose up -d", async () => {
        setNewImage(stack, plan.image);
        compose(stack, plan.guide.up);
        await waitForReady(stack.baseUrl);
      });
      await test.step("step 5: ready, on the version of this commit, and healthy", () => checkReadyAndVersion(stack, plan));
      await test.step("step 6: the instance is as seeded", () => readBack(stack, seeded, before));
      passed = true;
    } finally {
      await stack.finish(passed);
    }
  });

  test("upgrades with the migration run by hand when MIGRATE_ON_START is false, as the guide says", async ({}, info) => {
    test.setTimeout(DRILL_TEST_MS);
    const plan = planned();
    const { stack, seeded, before, releaseCandidate } = await startOnReleaseCandidate(plan);
    let passed = false;
    try {
      const shipped = shippedMigrations();
      expect(releaseCandidate.migrations, "the migrations the release candidate applied").toBeLessThanOrEqual(shipped);

      await test.step("the image and MIGRATE_ON_START=false are set in the env file, and docker compose up -d", () => {
        setNewImage(stack, plan.image);
        setEnvValue(stack.envFile, "MIGRATE_ON_START", "false");
        // The worker waits for a healthy server, which a server that has not migrated is not, so this command reports that.
        compose(stack, plan.guide.up, { allowFailure: true });
      });

      if (releaseCandidate.migrations < shipped) {
        await test.step("the server of this commit is not ready, with fewer migrations applied than it expects", async () => {
          const ready = await waitForNotReady(stack.baseUrl);
          expect(ready.status, `GET ${plan.guide.readyPath}`).toBe(503);
          expect(ready.expected, "the expected migrations in /ready").toBe(shipped);
          expect(ready.applied, "the applied migrations in /ready").toBe(releaseCandidate.migrations);
        });
      } else {
        info.annotations.push({ type: "note", description: "the image under test ships no migration beyond the release candidate, so the server is ready before the migration step" });
      }

      await test.step("docker compose run --rm slugbase migrate exits 0", () => {
        compose(stack, plan.guide.migrate);
      });

      await test.step("the server is ready and healthy, and docker compose up -d starts what waited for it", async () => {
        await waitForReady(stack.baseUrl);
        // The guide's troubleshooting: run `docker compose up -d` again once `slugbase` is healthy, which starts the worker.
        expect(await healthOfServer(stack), "the health of slugbase after the migration").toBe("healthy");
        compose(stack, plan.guide.up);
      });
      await test.step("ready, on the version of this commit, and healthy", () => checkReadyAndVersion(stack, plan));
      await test.step("the instance is as seeded", () => readBack(stack, seeded, before));
      passed = true;
    } finally {
      await stack.finish(passed);
    }
  });
});
