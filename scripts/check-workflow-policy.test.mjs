// Tests scripts/check-workflow-policy.mjs against fixture trees written to a
// throwaway directory under TMPDIR. Every tree is a copy of a clean base (a
// release workflow, a CI workflow, a composite action and a Dockerfile) plus the
// one file a case adds or replaces. A violation case names the file and the rule
// the finding must carry; a clean case must produce no finding at all; a final
// test fails when a rule of the check has no violation case. The fixtures hold
// ${{ ... }} expressions and backslashes that must stay literal. Secret names
// are fake (NPM_TOKEN is a name, never a value).
//
//   node scripts/check-workflow-policy.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_TABLES, RULES, checkRepository, isNpmInstallOrModifyWord } from "./check-workflow-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..");
const script = join(here, "check-workflow-policy.mjs");
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "workflow-policy-"));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** @type {Set<string>} */
const rulesWithAViolation = new Set();
let counter = 0;

/** @param {string[]} lines */
const y = (...lines) => `${lines.join("\n")}\n`;

const checkout = "actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0";
// The images a builder and an SBOM generator are pinned to, as the workflows name them.
const BUILDKIT = "moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe";
const GENERATOR = "docker/buildkit-syft-scanner:1.12.1@sha256:873a7458c3c8ac8e32c7b796c10e1600b07b963d2aa000a72a2d97aaaa2d6315";
const RELEASE = ".github/workflows/release.yml";
const CI = ".github/workflows/ci.yml";
const OTHER = ".github/workflows/other.yml";
const ACTION = ".github/actions/setup/action.yml";
const DOCKERFILE = "apps/slugbase/Dockerfile";
const YAML = "yaml";

/** The release workflow as it stands: a push to main, the image built and pushed. */
const releaseWorkflow = y(
  "name: Release",
  "# Runs on a push to main and nothing else.",
  "on:",
  "  push:",
  "    branches: [main]",
  "permissions: {}",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    permissions:",
  "      contents: write",
  "      packages: write",
  "    steps:",
  `      - uses: ${checkout}`,
  "      - name: Build and push",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "        run: |",
  "          set -euo pipefail",
  "          docker buildx build \\",
  "            --file apps/slugbase/Dockerfile \\",
  "            --push \\",
  '            --tag "$IMAGE:1" \\',
  "            .",
);

const ciWorkflow = y(
  "name: CI",
  "on:",
  "  push:",
  '    branches: ["**"]',
  "  pull_request:",
  "permissions:",
  "  contents: read",
  "  packages: read",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  `      - uses: ${checkout}`,
  "      - uses: ./.github/actions/setup",
  "      - run: pnpm lint",
  "      - run: pnpm --filter @slugbase/e2e test:e2e restore-drill",
  "      - run: pnpm exec playwright install chromium",
  "      - name: Build the image, not pushed",
  "        run: |",
  "          docker buildx build \\",
  `            --sbom=generator=${GENERATOR} \\`,
  '            --output "type=local,dest=$RUNNER_TEMP/image" \\',
  "            .",
  "      - run: git push --dry-run origin HEAD",
);

const setupAction = y(
  "name: Set up the workspace",
  "description: Installs pnpm from the packageManager field and the workspace from the lockfile.",
  "runs:",
  "  using: composite",
  "  steps:",
  "    - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0",
  "    - name: Install dependencies",
  "      shell: bash",
  "      run: pnpm install --frozen-lockfile",
);

const dockerfile = y(
  "# Stages: toolchain -> build (frozen-lockfile install) -> runtime.",
  "FROM node:24-slim AS toolchain",
  "RUN npm install --global --ignore-scripts pnpm@10.34.6",
  "FROM toolchain AS build",
  "COPY pnpm-lock.yaml pnpm-workspace.yaml ./",
  "RUN pnpm fetch",
  "RUN pnpm install --frozen-lockfile --offline",
  "RUN pnpm turbo run build --filter=slugbase \\",
  " && CI=true pnpm install --frozen-lockfile --offline --prod --ignore-scripts",
  'CMD ["server"]',
);

/**
 * A tree the check passes, with each given file written or (null) removed.
 * @param {Record<string, string | null>} [files]
 */
function tree(files = {}) {
  counter += 1;
  const dir = join(tmp, `tree-${String(counter)}`);
  /** @type {Record<string, string | null>} */
  const all = {
    [RELEASE]: releaseWorkflow,
    [CI]: ciWorkflow,
    [ACTION]: setupAction,
    [DOCKERFILE]: dockerfile,
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === null) {
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

/** @param {unknown[]} findings */
const describeFindings = (findings) => JSON.stringify(findings, null, 1);

/**
 * A case whose file makes the check fail with a finding naming the file and the rule.
 * @param {string} name
 * @param {string} file
 * @param {string} rule
 * @param {string[]} lines
 */
function violation(name, file, rule, ...lines) {
  test(name, () => {
    const { findings } = checkRepository(tree({ [file]: y(...lines) }));
    assert.ok(
      findings.some((finding) => finding.file === file && finding.rule === rule),
      `expected a finding of ${rule} naming ${file}, got ${describeFindings(findings)}`,
    );
    rulesWithAViolation.add(rule);
  });
}

/**
 * A case whose file the check passes without a finding.
 * @param {string} name
 * @param {string} file
 * @param {string[]} lines
 */
function clean(name, file, ...lines) {
  test(name, () => {
    const { findings } = checkRepository(tree({ [file]: y(...lines) }));
    assert.deepEqual(findings, [], describeFindings(findings));
  });
}

/** A workflow with one job and the given step lines after `steps:`. */
const pushJob = (...steps) => ["on: push", "permissions: {}", "jobs:", "  b:", "    steps:", ...steps];

/**
 * A `run:` value in a push-triggered workflow.
 * @param {string} name
 * @param {string} rule
 * @param {string} run
 * @param {string} [file]
 */
const runViolation = (name, rule, run, file = OTHER) => {
  violation(name, file, rule, ...pushJob(`      - run: ${run}`));
};

test("a tree that follows the policy passes", () => {
  const { findings } = checkRepository(tree());
  assert.deepEqual(findings, [], describeFindings(findings));
});

test("the repository's own workflows, actions and Dockerfiles pass", () => {
  const { findings, files } = checkRepository(repository);
  assert.deepEqual(findings, [], describeFindings(findings));
  assert.ok(files >= 10, `read only ${String(files)} files`);
});

// ---- Pull-request workflows read no secret --------------------------------------

const prHead = ["name: PR", "on:", "  pull_request:", "permissions: {}", "jobs:", "  t:", "    runs-on: ubuntu-latest", "    steps:"];
const PR = ".github/workflows/pr.yml";
const SECRETS = "pull-request-secrets";

violation("toJSON(secrets) in a pull_request workflow fails", PR, SECRETS, ...prHead, '      - run: echo "$ALL"', "        env:", "          ALL: ${{ toJSON(secrets) }}");
violation("secrets.NPM_TOKEN in a pull_request workflow fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
violation("secrets['NPM_TOKEN'] in a pull_request workflow fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          NPM_TOKEN: ${{ secrets['NPM_TOKEN'] }}");
violation("secrets [ \"NPM_TOKEN\" ] with spaces fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", '          NPM_TOKEN: ${{ secrets [ "NPM_TOKEN" ] }}');
violation("a bare secrets context fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          ALL: ${{ secrets }}");
violation("the upper-case SECRETS context fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          NPM_TOKEN: ${{ SECRETS.NPM_TOKEN }}");
violation("a secret named after the token with more letters fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          T: ${{ secrets.GITHUB_TOKEN_EXTRA }}");
violation("a secret read after a closing brace inside a string literal fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        env:", "          T: \"${{ '}}' && secrets.NPM_TOKEN }}\"");
violation("a secret read in an if condition without braces fails", PR, SECRETS, ...prHead, "      - run: pnpm lint", "        if: secrets.NPM_TOKEN != ''");
violation("a secret read in an expression key fails", PR, SECRETS, "on: pull_request", "jobs:", "  t:", "    strategy:", "      matrix:", '        "${{ secrets.NPM_TOKEN }}": [a]');
violation("secrets: inherit in a pull_request workflow fails", PR, SECRETS, "on:", "  pull_request:", "jobs:", "  call:", "    uses: ./.github/workflows/other.yml", "    secrets: inherit");
violation("a flow-mapping secrets: inherit fails", PR, SECRETS, "on: pull_request", "jobs:", "  call: {uses: ./.github/workflows/other.yml, secrets: inherit}");
violation("a quoted secrets: \"inherit\" fails", PR, SECRETS, "on: pull_request", "jobs:", "  call:", "    uses: ./.github/workflows/other.yml", '    "secrets": "inherit"');
violation("an environment key in a pull_request job fails", PR, SECRETS, "on:", "  pull_request:", "jobs:", "  t:", "    runs-on: ubuntu-latest", "    environment: production", "    steps:", "      - run: pnpm lint");
violation("a flow-mapping environment fails", PR, SECRETS, "on: pull_request", "jobs:", "  t: {runs-on: ubuntu-latest, environment: production, steps: []}");
violation("a quoted environment key fails", PR, SECRETS, "on: pull_request", "jobs:", "  t:", '    "environment": production');
violation("an environment key behind an explicit key fails", PR, SECRETS, "on: pull_request", "jobs:", "  t:", "    ? environment", "    : production");
violation("an upper-case Environment key fails", PR, SECRETS, "on: pull_request", "jobs:", "  t:", "    Environment: production");
violation("a pull_request scalar trigger is read", PR, SECRETS, "on: pull_request", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a pull_request flow-list trigger is read", PR, SECRETS, "on: [push, pull_request]", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a pull_request block-list trigger is read", PR, SECRETS, "on:", "  - push", "  - pull_request", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a quoted pull_request key is read", PR, SECRETS, "on:", '  "pull_request":', "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("an escaped pull_request name is read", PR, SECRETS, "on:", '  "pull\\x5frequest":', "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("an escaped secrets context is read", PR, SECRETS, "on: pull_request", "jobs:", "  t:", '    env: {X: "${{ \\x73ecrets.NPM_TOKEN }}"}');
violation("a secret behind a line-continued escape is read", PR, SECRETS, "on: pull_request", "jobs:", "  t:", '    env: {X: "${{ sec\\', '      rets.NPM_TOKEN }}"}');
violation("a pull_request_review workflow is read", PR, SECRETS, "on: pull_request_review", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a pull_request_target workflow is read", PR, SECRETS, "on: pull_request_target", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a workflow_run workflow is read", PR, SECRETS, "on:", "  workflow_run:", "    workflows: [CI]", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("an issue_comment workflow is read", PR, SECRETS, "on: issue_comment", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a reusable (workflow_call) workflow is read as startable by a pull request", PR, SECRETS, "on:", "  workflow_call:", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a trailing comment naming push does not hide a secret", PR, SECRETS, "on: pull_request # push", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("an anchored secret in a pull_request workflow fails", PR, SECRETS, "on: pull_request", "x-token: &token ${{ secrets.NPM_TOKEN }}", "jobs:", "  t:", "    env: {X: *token}");
violation("an anchor on the trigger is read", PR, SECRETS, "on: &t", "  pull_request:", "jobs:", "  t:", '    env: {X: "${{ secrets.NPM_TOKEN }}"}');
violation("a secret in a folded run scalar fails", PR, SECRETS, ...prHead, "      - run: >-", "          echo", "          ${{ secrets.NPM_TOKEN }}");
violation("an on value that is no trigger form fails", PR, SECRETS, "on: 5", "jobs: {}");
violation("a workflow with no on key fails", PR, SECRETS, "name: x", "jobs: {}");
violation("jobs that are no mapping fail", PR, SECRETS, "on: pull_request", "jobs: []");
violation("a job that is no mapping fails", PR, SECRETS, "on: pull_request", "jobs:", "  t: build");

clean("the workflow token in a pull_request workflow passes", PR, "on: pull_request", "permissions: {}", "jobs:", "  t:", "    steps:", "      - run: gh pr view", "        env:", "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
clean("the workflow token spelled secrets['github_token'] passes", PR, "on: pull_request", "permissions: {}", "jobs:", "  t:", "    steps:", "      - run: gh pr view", "        env:", "          GH_TOKEN: ${{ secrets [ 'github_token' ] }}");
clean("a named secret in a push-only workflow passes", PR, "on:", "  push:", "    branches: [main]", "  workflow_dispatch:", "permissions: {}", "jobs:", "  t:", "    steps:", "      - run: ./send", "        env:", "          TOKEN: ${{ secrets.DISPATCH_TOKEN }}");
clean("an environment in a push-only workflow passes", PR, "on: push", "permissions: {}", "jobs:", "  t:", "    environment: production", "    steps:", "      - run: ./deploy");
clean("secrets named in a full-line comment of a pull_request workflow pass", PR, "on: pull_request", "# No secrets: secrets.NPM_TOKEN is never read, nor an environment.", "permissions: {}", "jobs:", "  t:", "    steps:", "      - run: pnpm lint");
clean("the words secrets and environment in names and plain strings pass", PR, "on: pull_request", "permissions: {}", "jobs:", "  t:", "    steps:", "      - name: Print the environment, no secrets", "        run: echo environment secrets");

// ---- Image push only from the release workflow ------------------------------------

const PUSH = "image-push";

runViolation("a --push build in ci.yml fails", PUSH, "docker build -t x --push .", CI);
violation("a multi-line --push build in ci.yml fails", CI, PUSH, ...pushJob("      - run: |", "          docker buildx build \\", "            --push \\", "            --tag x ."));
runViolation("docker push fails", PUSH, "docker push ghcr.io/x/y:1");
runViolation("docker image push fails", PUSH, "docker image push ghcr.io/x/y:1");
runViolation("docker manifest push fails", PUSH, "docker manifest push ghcr.io/x/y:1");
runViolation("docker compose push fails", PUSH, "docker compose push");
runViolation("docker-compose push fails", PUSH, "docker-compose push");
runViolation("an output with push=true fails", PUSH, "docker buildx build --output type=image,name=x,push=true .");
runViolation("an output with push=1 fails", PUSH, "docker buildx build --output=type=image,push=1 .");
runViolation("an output with push= set by a variable fails", PUSH, 'docker buildx build --output "type=image,push=$PUSH" .');
runViolation("--push=true fails", PUSH, "docker buildx build --push=true .");
runViolation("an output of type registry fails", PUSH, "docker buildx build --output=type=registry,name=x .");
runViolation("a quoted output of type registry fails", PUSH, "docker buildx build -o 'type=registry,name=x' .");
runViolation("-o registry fails", PUSH, "docker buildx build -o registry .");
runViolation("a quoted push word fails", PUSH, 'docker "pu""sh" x');
runViolation("a quoted tool word fails", PUSH, '|\n          "docker" push x');
runViolation("an empty quote inside the tool word fails", PUSH, 'doc""ker push x');
runViolation("imagetools create fails", PUSH, "docker buildx imagetools create -t x:2 x:1");
runViolation("podman push fails", PUSH, "podman push x");
runViolation("buildah push fails", PUSH, "buildah push x docker://x/y");
runViolation("nerdctl push fails", PUSH, "nerdctl push x");
runViolation("skopeo copy to a registry fails", PUSH, "skopeo copy docker://x/y:1 docker://x/y:2");
runViolation("crane fails", PUSH, "crane copy x y");
runViolation("oras fails", PUSH, "oras push x");
runViolation("regctl fails", PUSH, "regctl image copy x y");
runViolation("an escaped push fails", PUSH, '"docker pu\\x73h x"');
runViolation("d\\ocker push fails", PUSH, "d\\ocker push ghcr.io/x/y");
runViolation("docker pu\\sh fails", PUSH, "docker pu\\sh ghcr.io/x/y");
runViolation("a path to the tool fails", PUSH, "/usr/bin/docker push x");
runViolation("sudo docker push fails", PUSH, "sudo docker push x");
runViolation("command docker push fails", PUSH, "command docker push x");
runViolation("env X=1 docker push fails", PUSH, "env X=1 docker push x");
runViolation("a global option with a value before push fails", PUSH, "docker --context x push ghcr.io/x/y");
runViolation("a push after a semicolon fails", PUSH, "true; docker push x");
runViolation("a push after && fails", PUSH, "true && docker push x");
runViolation("a push after || fails", PUSH, "false || docker push x");
runViolation("a push after a pipe fails", PUSH, "echo x | docker push x");
runViolation("a push after & fails", PUSH, "sleep 1 & docker push x");
runViolation("a push in a command substitution fails", PUSH, "echo $(docker push x)");
runViolation("a push in a backtick substitution fails", PUSH, "echo `docker push x`");
runViolation("a push in a substitution inside double quotes fails", PUSH, 'echo "$(docker push x)"');
runViolation("a push in a subshell fails", PUSH, "(docker push x)");
runViolation("a push through sh -c fails", PUSH, "sh -c 'docker push x'");
runViolation("a push through bash -c with double quotes fails", PUSH, 'bash -c "docker push x"');
runViolation("a push through eval fails", PUSH, 'eval "docker push x"');
runViolation("a push through xargs sh -c fails", PUSH, "echo x | xargs -I{} sh -c 'docker push {}'");
runViolation("a push through nested shells fails", PUSH, `sh -c "sh -c 'docker push x'"`);
runViolation("a push in an ANSI-C quoted word fails", PUSH, "docker $'\\x70ush' x");
runViolation("a push in an octal ANSI-C word fails", PUSH, "docker $'\\160ush' x");
runViolation("a push around an expression fails", PUSH, "docker ${{ github.event.x || '' }} push x");
runViolation("a push after an expression with a literal brace pair fails", PUSH, "echo ${{ '}}' }} ; docker push x");
violation("a push behind a continuation inside a block scalar fails", OTHER, PUSH, ...pushJob("      - run: |", "          docker \\", "            push ghcr.io/x/y"));
violation("a push behind a continuation and a comment line fails", OTHER, PUSH, ...pushJob("      - run: |", "          docker \\", "            --context x \\", "            push ghcr.io/x/y"));
violation("a push in a heredoc body is read as a command", OTHER, PUSH, ...pushJob("      - run: |", "          cat <<EOF", "          docker push x", "          EOF"));
violation("docker/build-push-action with push: true fails", OTHER, PUSH, ...pushJob("      - uses: docker/build-push-action@0000000000000000000000000000000000000000", "        with:", "          push: true"));
violation("docker/build-push-action with push false in a comment only fails", OTHER, PUSH, ...pushJob("      - uses: docker/build-push-action@0000000000000000000000000000000000000000", "        with:", "          context: .  # push: false"));
violation("docker/build-push-action with an expression for push fails", OTHER, PUSH, ...pushJob("      - uses: docker/build-push-action@0000000000000000000000000000000000000000", "        with:", "          push: ${{ github.ref == 'refs/heads/main' }}"));
violation("another action with push: true in a flow mapping fails", OTHER, PUSH, ...pushJob("      - {uses: docker/bake-action@0000000000000000000000000000000000000000, with: {push: true}}"));
violation("an action input with push=falsey fails", OTHER, PUSH, ...pushJob("      - uses: docker/bake-action@0000000000000000000000000000000000000000", "        with:", "          set: |", "            *.output=type=image,push=falsey"));
violation("an action input with push=0x1 fails", OTHER, PUSH, ...pushJob("      - uses: docker/bake-action@0000000000000000000000000000000000000000", "        with:", "          set: |", "            *.output=type=image,push=0x1"));
clean("an action input with push=false passes", OTHER, ...pushJob("      - uses: docker/bake-action@0000000000000000000000000000000000000000", "        with:", "          set: |", "            *.output=type=image,push=false"));
clean("an action input with push=0 passes", OTHER, ...pushJob("      - uses: docker/bake-action@0000000000000000000000000000000000000000", "        with:", "          set: |", "            *.output=type=image,push=0"));
violation("an action with an output of type registry fails", OTHER, PUSH, ...pushJob("      - uses: docker/bake-action@0000000000000000000000000000000000000000", "        with:", "          set: |", "            *.output=type=registry"));
violation("an action named for pushing fails", OTHER, PUSH, ...pushJob("      - uses: redhat-actions/push-to-registry@0000000000000000000000000000000000000000"));
violation("a quoted uses key naming a pushing action fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    steps:", '      - "uses": docker/build-push-action@0000000000000000000000000000000000000000');
violation("a reusable workflow named for pushing fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    uses: org/repo/.github/workflows/push-image.yml@main");
violation("packages: write in another workflow fails", OTHER, PUSH, "on: push", "permissions:", "  contents: read", "  packages: write", "jobs: {}");
violation("packages: write in a job of another workflow fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    permissions:", "      packages: write", "    steps: []");
violation("a flow-mapping packages: write fails", OTHER, PUSH, "on: push", "permissions: {contents: read, packages: write}", "jobs: {}");
violation("a quoted packages: write fails", OTHER, PUSH, "on: push", "permissions:", '  "packages": "write"', "jobs: {}");
violation("a packages permission on its own line fails", OTHER, PUSH, "on: push", "permissions:", "  packages:", "    write", "jobs: {}");
violation("a packages permission set by an expression fails", OTHER, PUSH, "on: push", "permissions:", "  packages: ${{ vars.LEVEL }}", "jobs: {}");
violation("packages: write through an alias fails", OTHER, PUSH, "on: push", "x-p: &p", "  packages: write", "permissions: *p", "jobs: {}");
violation("an upper-case Packages: Write fails", OTHER, PUSH, "on: push", "permissions:", "  Packages: Write", "jobs: {}");
violation("write-all in another workflow fails", OTHER, PUSH, "on: push", "permissions: write-all", "jobs: {}");
test("write-all is named as such", () => {
  const { findings } = checkRepository(tree({ [OTHER]: y("on: push", "permissions: write-all", "jobs: {}") }));
  assert.ok(findings.some((finding) => finding.rule === PUSH && /write-all grants packages: write/.test(finding.message)), describeFindings(findings));
});
violation("write-all in a job fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    permissions: write-all", "    steps: []");
violation("write-all in release.yml fails", RELEASE, PUSH, "on:", "  push:", "    branches: [main]", "permissions: write-all", "jobs: {}");
violation("a permissions scalar of another kind fails", OTHER, PUSH, "on: push", "permissions: write", "jobs: {}");
violation("a release.yaml copy that pushes fails", ".github/workflows/release.yaml", PUSH, "on: push", "permissions:", "  packages: write", "jobs: {}");
violation("an upper-case Release.yml that pushes fails", ".github/workflows/Release.yml", PUSH, "on: push", "jobs:", "  b:", "    steps:", "      - run: docker push x");
violation("packages: write in a composite action fails", ".github/actions/publish/action.yml", PUSH, "permissions:", "  packages: write", "runs:", "  using: composite", "  steps: []");
violation("docker push in a composite action fails", ".github/actions/publish/action.yml", PUSH, "runs:", "  using: composite", "  steps:", "    - shell: bash", "      run: docker push x");
violation("a build split by a folded scalar fails", OTHER, PUSH, ...pushJob("      - run: >", "          docker buildx build", "          --push ."));
violation("a build split by a folded strip scalar fails", OTHER, PUSH, ...pushJob("      - run: >-", "          docker buildx build", "          --tag x", "          --push ."));
violation("a build split by a plain multi-line scalar fails", OTHER, PUSH, ...pushJob("      - run: docker buildx build", "          --push ."));
violation("a build split by a double-quoted multi-line scalar fails", OTHER, PUSH, ...pushJob('      - run: "docker buildx build', '          --push ."'));
violation("a build split by a single-quoted multi-line scalar fails", OTHER, PUSH, ...pushJob("      - run: 'docker buildx build", "          --push .'"));
violation("an output with push=true on a later line fails", OTHER, PUSH, ...pushJob("      - run: >-", "          docker buildx build", "          --output=type=image,push=true", "          ."));
violation("an output of type registry on a later line fails", OTHER, PUSH, ...pushJob("      - run: >-", "          docker buildx build", "          --output type=registry", "          ."));
violation("a global option with a value before push in a folded scalar fails", OTHER, PUSH, ...pushJob("      - run: >-", "          docker", "          --context x", "          push ghcr.io/x/y"));
violation("--config dir across lines before push fails", OTHER, PUSH, ...pushJob("      - run: >-", "          docker", "          --config dir", "          push ghcr.io/x/y"));
violation("-H host before push in a plain multi-line scalar fails", OTHER, PUSH, ...pushJob("      - run: docker", "          -H tcp://host:2375", "          push ghcr.io/x/y"));
violation("podman --url before push fails", OTHER, PUSH, ...pushJob("      - run: >-", "          podman --url ssh://host", "          push ghcr.io/x/y"));
runViolation("a tab escape between docker and push fails", PUSH, '"docker\\tpush ghcr.io/x/y"');
runViolation("an escaped backslash and newline between docker and push fails", PUSH, '"docker \\\\\\npush ghcr.io/x/y"');
violation("a double-quoted scalar continued at a lower indent fails", OTHER, PUSH, ...pushJob('      - run: "docker', '          push ghcr.io/x/y"'));
runViolation("an escaped space between docker and push fails", PUSH, '"docker\\ push ghcr.io/x/y"');
violation("a push after unrelated words and lines of the same step fails", OTHER, PUSH, ...pushJob("      - run: |", "          docker --log-level debug --tlsverify \\", "            --host tcp://h:1 context use x", "          echo done", "          docker image tag a b", "          docker push x"));
// Round three of the rejected shell attempt: an escaped line break followed by an escaped space or tab.
violation('an escaped line break and an escaped space ("docker\\ / \\ push") fails', OTHER, PUSH, ...pushJob('      - run: "docker\\', '          \\ push ghcr.io/x/y"'));
violation("an escaped line break and an escaped tab fails", OTHER, PUSH, ...pushJob('      - run: "docker\\', '          \\tpush ghcr.io/x/y"'));
violation("an escaped line break and a global option before push fails", OTHER, PUSH, ...pushJob('      - run: "docker --context x\\', '          \\ push ghcr.io/x/y"'));
violation("a comment ending in : | before an escaped push fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    steps: # see: |", '      - run: "docker\\tpush ghcr.io/x/y"');
violation("a comment ending in : > before an escaped push fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    steps: # see: >", '      - run: "d\\x6fcker push ghcr.io/x/y"');
violation("a docker push hidden in a comment-looking quoted word fails", OTHER, PUSH, ...pushJob("      - run: |", "          echo x # not a comment: |", "          docker push x"));

clean("packages: read and none in other workflows pass", OTHER, "on: push", "permissions:", "  contents: read", "  packages: read", "jobs:", "  b:", "    permissions: {packages: none}", "    steps: []");
clean("permissions: read-all and an empty permissions pass", OTHER, "on: push", "permissions: read-all", "jobs:", "  b:", "    permissions: {}", "    steps: []");
clean("a local docker build and git push (no docker) pass", OTHER, ...pushJob("      - run: docker build --load -t x .", "      - run: git push origin HEAD"));
clean("docker/build-push-action named only in a comment passes", OTHER, "on: push", "# Not docker/build-push-action: docker buildx build --push belongs to release.yml.", "permissions: {}", "jobs: {}");
clean("a multi-line local build with SBOM and a local output passes", CI, ...pushJob("      - run: |", "          docker buildx build \\", `            --sbom=generator=${GENERATOR} \\`, '            --output "type=local,dest=$RUNNER_TEMP/image" \\', "            .", "      - run: >-", "          docker buildx build", "          --output=type=docker ."));
clean("push=false and --push=false pass", OTHER, ...pushJob("      - run: docker buildx build --push=false --output type=image,push=false ."));
clean("an escaped newline between docker and push is two commands", OTHER, ...pushJob('      - run: "docker\\npush ghcr.io/x/y"'));
clean("docker and a later push in another command pass", OTHER, ...pushJob("      - run: docker build -t x . && git push origin HEAD", "      - run: docker build -t x .; git push origin HEAD", "      - run: docker build -t x . | tee log"));
clean("docker and a push separated by a blank line pass", CI, ...pushJob("      - run: |", "          docker build -t x .", "", "          git push origin HEAD"));
clean("docker and a push in the next step pass", CI, ...pushJob("      - run: docker build -t x .", "      - name: Publish the notes", "        run: git push origin HEAD"));
clean("docker in one job and push in a later job pass", CI, "on: push", "permissions: {}", "jobs:", "  a:", "    steps:", "      - run: docker build -t x .", "  b:", "    if: github.event_name == 'push'", "    steps: []");
clean("push in a trigger, a step name and a branch list pass", OTHER, "on:", "  push:", "    branches: [push, dev]", "permissions: {}", "jobs:", "  b:", "    steps:", "      - name: Build docker image on push", "        run: docker build -t x .");
clean("a push word in a shell comment after the command passes", OTHER, ...pushJob("      - run: |", "          docker build -t x . # push it later"));
clean("docker/setup-buildx-action passes", OTHER, ...pushJob("      - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000", "        with:", "          push: false", `          driver-opts: image=${BUILDKIT}`));
clean("a docker format template in single quotes passes", OTHER, ...pushJob("      - run: |", "          docker ps --all --format '{{.ID}} {{.Label \"com.docker.compose.project\"}}' |", "            xargs --no-run-if-empty docker rm --force --volumes"));
clean("a backslash in a plain scalar, a block scalar and a known escape pass", OTHER, ...pushJob('      - run: docker pull "$(sed -n s/^K="\\(.*\\)";$/\\1/p f)"', "      - run: |", '          jq -r "\\(.a) \\q"', '          "a\\qb" c', '      - run: "echo a\\tb \\\\ \\" \\/ \\x41"'));
clean("a trigger map with a branch list passes", OTHER, "on: {push: {branches: [dev]}}", "permissions: {}", "jobs:", "  b:", "    steps:", "      - run: docker build -t x .");

// A command name from a substitution or a parameter is read as possibly any tool.
runViolation("a tool name from $(echo docker) fails", PUSH, "$(echo docker) push x");
runViolation("a tool name behind timeout fails", PUSH, "timeout 60 $DOCKER push x");
runViolation("a tool name behind timeout and an option fails", PUSH, "timeout -s KILL 60 $DOCKER push x");
runViolation("a substituted tool name behind timeout fails", PUSH, "timeout 60 $(which docker) push x");
runViolation("a tool name behind chrt fails", PUSH, "chrt 10 $DOCKER push x");
runViolation("a tool name behind flock fails", PUSH, "flock /tmp/l $DOCKER push x");
runViolation("a tool name behind retry fails", PUSH, "retry 3 $DOCKER push x");
runViolation("a tool name behind a wrapper nobody knows fails", PUSH, "wrapper-nobody-knows 3 $DOCKER push x");
runViolation("a tool name behind taskset and env fails", PUSH, "taskset 0x1 env X=1 $DOCKER push x");
runViolation("a tool name from backticks fails", PUSH, "|\n          `echo docker` push x");
runViolation("a tool name from $(which docker) fails", PUSH, "$(which docker) push x");
runViolation("a quoted tool name from $(command -v docker) fails", PUSH, '|\n          "$(command -v docker)" push x');
runViolation("a substituted tool name behind sudo fails", PUSH, "sudo $(which docker) push x");
runViolation("a substituted tool name behind env fails", PUSH, "env X=1 $(which docker) push x");
runViolation("a substituted tool name behind sudo and its option value fails", PUSH, "sudo -u root $(which docker) push x");
runViolation("a substituted tool name behind an assignment fails", PUSH, "X=1 $(which docker) image push x");
runViolation("a tool name from a parameter fails", PUSH, "$DOCKER push x");
runViolation("a tool name from a braced parameter fails", PUSH, "${DOCKER} push x");
runViolation("a tool name from arithmetic fails", PUSH, "$((1)) push x");
runViolation("a substituted tool name with --push later fails", PUSH, "$(which docker) buildx build --push .");
runViolation("a substituted tool name inside sh -c fails", PUSH, `sh -c '$(which docker) push x'`);
violation("an exec-form tool name from a parameter fails", DOCKERFILE, PUSH, "FROM node:24-slim", 'RUN ["$DOCKER", "push", "x"]');
runViolation("a pipeline whose second command has a substituted tool fails", PUSH, "echo x | $(which docker) push x");
clean("a parameter-only command from a quoted string is not read as an install", OTHER, ...pushJob('      - run: echo "${sha}  ${archive}" | sha256sum --check --strict -'));
clean("a substitution as an argument is not a command name", OTHER, ...pushJob("      - run: X=$(id) git push origin HEAD", "      - run: env X=1 echo \"$HOME\" done", "      - run: docker build -t \"$(git rev-parse HEAD)\" ."));
// A dynamic word before the word push is read as a possible tool, so these are known false positives.
runViolation("a substitution before the word push is a known false positive", PUSH, "echo $(date) push");
runViolation("a quoted substitution before push is a known false positive", PUSH, 'git commit -m "$(cat msg)" push');
runViolation("git -C with a parameter before push is a known false positive", PUSH, 'git -C "$DIR" push');
runViolation("an expression before the word push is a known false positive", PUSH, "echo ${{ github.sha }} push");

// ---- The release workflow runs only on a push to main or a published release --------

const TRIGGERS = "release-triggers";
const relBody = ["permissions: {}", "jobs:", "  b:", "    runs-on: ubuntu-latest", "    steps:", "      - run: docker buildx build --push ."];

violation("release.yml with workflow_dispatch fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  workflow_dispatch:", ...relBody);
violation("release.yml with a schedule fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  schedule:", '    - cron: "0 0 * * *"', ...relBody);
violation("release.yml with pull_request fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  pull_request:", ...relBody);
violation("release.yml with pull_request_target fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  pull_request_target:", ...relBody);
violation("release.yml with workflow_run fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  workflow_run:", "    workflows: [CI]", ...relBody);
violation("release.yml with workflow_call fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  workflow_call:", ...relBody);
violation("release.yml with issue_comment fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "  issue_comment:", ...relBody);
violation("release.yml pushing on another branch fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main, dev]", ...relBody);
violation("release.yml pushing on another single branch fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [dev]", ...relBody);
violation("release.yml pushing on a branch that only starts with main fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main-next]", ...relBody);
violation("release.yml pushing on a list of two branches fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches:", "      - main", "      - dev", ...relBody);
violation("release.yml pushing on every branch fails", RELEASE, TRIGGERS, "on:", "  push:", '    branches: ["**"]', ...relBody);
violation("release.yml with a push and no branch filter fails", RELEASE, TRIGGERS, "on:", "  push:", ...relBody);
violation("release.yml with a push on tags fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", '    tags: ["v*"]', ...relBody);
violation("release.yml with a paths filter fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "    paths: [apps/**]", ...relBody);
violation("release.yml with branches-ignore fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", "    branches-ignore: [dev]", ...relBody);
violation("release.yml with a scalar trigger fails", RELEASE, TRIGGERS, "on: push", ...relBody);
violation("release.yml with a flow-list trigger fails", RELEASE, TRIGGERS, "on: [push]", ...relBody);
violation("release.yml with a flow-mapping trigger fails", RELEASE, TRIGGERS, "on: {push: {branches: [main]}, workflow_dispatch: {}}", ...relBody);
violation("release.yml with a quoted on key fails", RELEASE, TRIGGERS, '"on":', "  push:", "    branches: [main, dev]", ...relBody);
violation("release.yml with the on key behind an explicit key fails", RELEASE, TRIGGERS, "? on", ": {push: {branches: [main]}, workflow_dispatch: {}}", ...relBody);
violation("release.yml with an upper-case ON key fails", RELEASE, TRIGGERS, "ON:", "  push:", "    branches: [main]", "  workflow_dispatch:", ...relBody);
violation("release.yml with no on key fails", RELEASE, TRIGGERS, "name: Release", ...relBody);
violation("release.yml with an empty on block fails", RELEASE, TRIGGERS, "on:", ...relBody);
violation("release.yml with a release of another type fails", RELEASE, TRIGGERS, "on:", "  release:", "    types: [created]", ...relBody);
violation("release.yml with a release of several types fails", RELEASE, TRIGGERS, "on:", "  release:", "    types: [published, created]", ...relBody);
violation("release.yml with a release and no types fails", RELEASE, TRIGGERS, "on:", "  release:", ...relBody);
violation("release.yml with a trigger pulled in through an alias fails", RELEASE, TRIGGERS, "x-on: &t {push: {branches: [main]}, workflow_dispatch: {}}", "on: *t", ...relBody);
violation("release.yml with an escaped trigger name fails", RELEASE, TRIGGERS, "on:", "  push:", "    branches: [main]", '  "workflow\\x5fdispatch":', ...relBody);
violation("release.yml with a comment ending in : | before an escaped trigger fails", RELEASE, TRIGGERS, "on: # triggers: |", '  "pull_request\\x5ftarget":', ...relBody);
violation("release.yml with a comment ending in : > before an escaped trigger fails", RELEASE, TRIGGERS, "on: # triggers: >", '  "workflow\\x5fdispatch":', ...relBody);
violation("release.yml with a tab-indented trigger fails", RELEASE, "yaml", "on:", "  push:", "\tbranches: [main]", ...relBody);

clean("release.yml on a push to main and a published release passes", RELEASE, "on:", "  push:", "    branches: [main]", "  release:", "    types: [published]", ...relBody);
clean("release.yml on a published release alone passes", RELEASE, "on:", "  release:", "    types: [published]", ...relBody);
clean("release.yml with list-form branches and types and quotes passes", RELEASE, "on:   # when", "  release:", "    types:", '      - "published"', "  push:", "    # only main", "    branches:", "      - 'main'", ...relBody);
clean("release.yml with comments and blank lines in the trigger block passes", RELEASE, "# triggers", "on:", "", "  push:   # the branch", "    branches: [ main ]", "", ...relBody);
violation("release.yml with a second on key fails", RELEASE, YAML, "on:", "  push:", "    branches: [main]", "on:", "  workflow_dispatch:", ...relBody);
clean("release.yml with an anchor on the trigger passes", RELEASE, "on: &t", "  push:", "    branches: [main]", ...relBody);
clean("release.yml with an unknown top-level key passes (it is not a trigger)", RELEASE, "on:", "  push:", "    branches: [main]", "&a on-too: {workflow_dispatch: {}}", ...relBody);
clean("a leading document marker on one document passes", RELEASE, "---", "on:", "  push:", "    branches: [main]", ...relBody);
clean("release.yml may push images and hold packages: write", RELEASE, "on:", "  push:", "    branches: [main]", "permissions:", "  packages: write", "jobs:", "  b:", "    steps:", "      - run: skopeo copy a b", "      - uses: docker/build-push-action@0000000000000000000000000000000000000000", "        with:", "          push: true");

// ---- Every workspace install uses the frozen lockfile ---------------------------------

const FROZEN = "frozen-lockfile";

violation("pnpm install without the flag in a composite action fails", ACTION, FROZEN, "runs:", "  using: composite", "  steps:", "    - shell: bash", "      run: pnpm install");
violation("pnpm install without the flag in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN pnpm install --offline");
runViolation("pnpm install without the flag in a workflow fails", FROZEN, "pnpm install");
runViolation("pnpm i without the flag fails", FROZEN, "pnpm i");
runViolation("pnpm install-test without the flag fails", FROZEN, "pnpm install-test");
runViolation("pnpm install --no-frozen-lockfile fails", FROZEN, "pnpm install --frozen-lockfile --no-frozen-lockfile");
runViolation("pnpm install --frozen-lockfile=false fails", FROZEN, "pnpm install --frozen-lockfile=false");
runViolation("pnpm install --no-frozen-lockfile alone fails", FROZEN, "pnpm install --no-frozen-lockfile");
violation("the frozen-lockfile setting turned off by a Dockerfile ENV fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "ENV PNPM_CONFIG_FROZEN_LOCKFILE=false", "RUN pnpm install --frozen-lockfile");
violation("a frozen-lockfile ARG in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "ARG npm_config_frozen_lockfile=true");
violation("PNPM_FROZEN_LOCKFILE in a step's env fails", OTHER, FROZEN, ...pushJob("      - run: pnpm install --frozen-lockfile", "        env:", '          PNPM_FROZEN_LOCKFILE: "false"'));
violation("npm_config_frozen_lockfile in the workflow env fails", OTHER, FROZEN, "on: push", "env:", "  npm_config_frozen_lockfile: false", "jobs: {}");
runViolation("a frozen-lockfile variable set before the command fails", FROZEN, "PNPM_FROZEN_LOCKFILE=false pnpm install --frozen-lockfile");
runViolation("a frozen-lockfile variable written to the environment file fails", FROZEN, 'echo "PNPM_FROZEN_LOCKFILE=false" >> "$GITHUB_ENV"');
runViolation("frozen-lockfile=false written to .npmrc fails", FROZEN, 'echo "frozen-lockfile=false" >> .npmrc');
runViolation("pnpm install --fix-lockfile fails", FROZEN, "pnpm install --frozen-lockfile --fix-lockfile");
runViolation("pnpm install --lockfile-only fails", FROZEN, "pnpm install --frozen-lockfile --lockfile-only");
runViolation("pnpm add fails", FROZEN, "pnpm add left-pad");
runViolation("pnpm add with the flag still fails", FROZEN, "pnpm add --frozen-lockfile left-pad");
runViolation("pnpm update fails", FROZEN, "pnpm update");
runViolation("pnpm up fails", FROZEN, "pnpm -r up --latest");
runViolation("pnpm upgrade fails", FROZEN, "pnpm upgrade");
runViolation("pnpm dedupe fails", FROZEN, "pnpm dedupe");
runViolation("pnpm import fails", FROZEN, "pnpm import");
runViolation("pnpm remove fails", FROZEN, "pnpm remove left-pad");
runViolation("pnpm install behind a filter option fails", FROZEN, "pnpm --filter @slugbase/web install");
runViolation("pnpm install behind an unknown option with a value fails", FROZEN, "pnpm --some-option value install");
violation("pnpm install behind a directory option fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN pnpm -C /app install");
runViolation("a quoted command word fails", FROZEN, "|\n          \"pnpm\" 'install'");
runViolation("an escaped command word fails", FROZEN, '"pn\\x70m install"');
runViolation("a backslash inside the command word fails", FROZEN, "pn\\pm install");
violation('"pnpm\\ / \\ install" with an escaped space after an escaped line break fails', OTHER, FROZEN, ...pushJob('      - run: "pnpm\\', '          \\ install"'));
violation("pnpm and an escaped tab then install fails", OTHER, FROZEN, ...pushJob('      - run: "pnpm\\', '          \\tinstall"'));
violation("a comment ending in : | before an escaped install fails", OTHER, FROZEN, "on: push", "jobs:", "  b:", "    steps: # see: |", '      - run: "pn\\x70m install"');
runViolation("pnpm run through corepack fails", FROZEN, "corepack pnpm install");
runViolation("pnpm run through a pinned npx fails", FROZEN, "npx pnpm@10 install");
runViolation("pnpm run by path fails", FROZEN, "./node_modules/.bin/pnpm install");
runViolation("pnpm run through its script file fails", FROZEN, "node ./pnpm.cjs install");
runViolation("the flag on a later command does not cover the install", FROZEN, "pnpm install && pnpm install --frozen-lockfile");
runViolation("an unflagged install after a flagged one fails", FROZEN, "pnpm install --frozen-lockfile || pnpm install");
runViolation("an install after a semicolon fails", FROZEN, "true; pnpm install");
runViolation("an install inside a command substitution fails", FROZEN, "echo $(pnpm install)");
runViolation("an install inside sh -c fails", FROZEN, "sh -c 'pnpm install'");
violation("an install in a flow-mapping step fails", OTHER, FROZEN, ...pushJob('      - {name: x, run: "pnpm install", shell: bash}'));
runViolation("the flag in a trailing comment does not count", FROZEN, "pnpm install # --frozen-lockfile");
runViolation("the flag in a shell comment of a block scalar does not count", FROZEN, "|\n          pnpm install # --frozen-lockfile");
runViolation("--global in a shell comment of a block scalar does not count", FROZEN, "|\n          npm install # --global");
violation("the flag in the next line of a block does not count", OTHER, FROZEN, ...pushJob("      - run: |", "          pnpm install", "          --frozen-lockfile"));
violation("a comment line between continued lines does not hide the missing flag", OTHER, FROZEN, ...pushJob("      - run: |", "          pnpm install \\", "          # frozen", "          --frozen-lockfile"));
violation("a comment line ending in a backslash does not hide an install", OTHER, FROZEN, "on: push", "jobs:", "  b:", "    steps:", "      # note \\", "      - run: pnpm install");
runViolation("an install from a folded scalar without the flag fails", FROZEN, ">-\n          pnpm\n          install");
runViolation("npm install without --global fails", FROZEN, "npm install");
runViolation("npm ci fails", FROZEN, "npm ci");
runViolation("npm i fails", FROZEN, "npm i left-pad");
runViolation("npm install with -g after -- is an argument and fails", FROZEN, "npm install left-pad -- -g");
runViolation("npm install --global=false fails", FROZEN, "npm install --global=false pnpm@10.34.6");
runViolation("npm install with --global only in a comment fails", FROZEN, "npm install # --global");
runViolation("npm install after an option with a value fails", FROZEN, "npm --prefix x install left-pad");
runViolation("npm install after an option value named like a command fails", FROZEN, "npm --prefix test install left-pad");
runViolation("npm install after an unknown option and a command-like word fails", FROZEN, "npm --unknown test install left-pad");
runViolation("pnpm install after a filter named like a command fails", FROZEN, "pnpm --filter run install");
runViolation("pnpm install after an unknown option and a command-like word fails", FROZEN, "pnpm --unknown exec install");
violation("npm i in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN npm i left-pad");
violation("npm install --global=false in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN npm install --global=false pnpm@10.34.6");
runViolation("yarn install fails", FROZEN, "yarn install");
runViolation("corepack yarn fails", FROZEN, "corepack yarn");
violation("a bare yarn in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN yarn");
violation("an install in e2e/Dockerfile fails", "e2e/Dockerfile", FROZEN, "FROM node:24-slim", "RUN pnpm install");
violation("an install in a Dockerfile with a suffix fails", "docker/Dockerfile.dev", FROZEN, "FROM node:24-slim", "RUN pnpm install");
violation("an install in a *.Dockerfile fails", "docker/web.Dockerfile", FROZEN, "FROM node:24-slim", "RUN pnpm install");
violation("an install in a Containerfile fails", "Containerfile", FROZEN, "FROM node:24-slim", "RUN pnpm install");
violation("an install in a nested composite action fails", ".github/actions/deep/er/action.yaml", FROZEN, "runs:", "  using: composite", "  steps:", "    - shell: bash", "      run: pnpm install");
violation("an install in a source-named file that starts like a Dockerfile fails", "docker/Dockerfile.sh", FROZEN, "FROM node:24-slim", "RUN pnpm install");

runViolation("a dynamic command name followed by install is read as an install (a known false positive)", FROZEN, "$MAKE install");
runViolation("a package manager name from $(echo pnpm) fails", FROZEN, "$(echo pnpm) install");
runViolation("a package manager name from a parameter fails", FROZEN, "$PNPM install");
runViolation("a package manager name from a parameter running add fails", FROZEN, "${PNPM} add left-pad");
runViolation("a package manager name behind env from backticks fails", FROZEN, "env X=1 `which pnpm` i");
runViolation("a subcommand from a substitution fails", FROZEN, "pnpm $(echo i)");
runViolation("a subcommand from a parameter fails", FROZEN, "pnpm $CMD");
runViolation("a subcommand after a filter, from a substitution, fails", FROZEN, "pnpm --filter x $(echo add) y");
runViolation("--frozen-lockfile false (two words) fails", FROZEN, "pnpm install --frozen-lockfile false");
runViolation("--frozen-lockfile 0 fails", FROZEN, "pnpm install --frozen-lockfile 0");
runViolation("--frozen-lockfile no fails", FROZEN, "pnpm install --frozen-lockfile no");
runViolation("--frozen-lockfile off in capitals fails", FROZEN, "pnpm install --frozen-lockfile OFF");
runViolation("--frozen-lockfile= with the value as the next word fails", FROZEN, "pnpm install '--frozen-lockfile=' false");
runViolation("--frozen-lockfile with a value from a substitution fails", FROZEN, "pnpm install --frozen-lockfile $(echo false)");
runViolation("--frozen-lockfile with a value from a parameter fails", FROZEN, 'pnpm install --frozen-lockfile "$FLAG"');
runViolation("--global false does not make an npm install global", FROZEN, "npm install --global false left-pad");
runViolation("-g false does not make an npm install global", FROZEN, "npm install -g false left-pad");
runViolation("pnpm recursive install fails", FROZEN, "pnpm recursive install");
runViolation("pnpm multi install fails", FROZEN, "pnpm multi install");
runViolation("pnpm m i fails", FROZEN, "pnpm m i");
runViolation("pnpm recursive add fails", FROZEN, "pnpm recursive add left-pad");
runViolation("pnpm -r install fails", FROZEN, "pnpm -r install");
runViolation("pnpm --filter x install fails", FROZEN, "pnpm --filter x install");
runViolation("pnpm -C dir i fails", FROZEN, "pnpm -C dir i");
runViolation("pnpm --dir dir install fails", FROZEN, "pnpm --dir dir install");
runViolation("pnpm --workspace-root install fails", FROZEN, "pnpm --workspace-root install");
runViolation("pnpm --config.x=y install fails", FROZEN, "pnpm --config.x=y install");
runViolation("pnpm --reporter silent install fails", FROZEN, "pnpm --reporter silent install");
runViolation("pnpm after an option of unknown kind is read as possibly an install", FROZEN, "pnpm --weird-option build");
runViolation("pnpm unlink fails", FROZEN, "pnpm unlink");
// A boolean flag takes a following true/false as its value, so the subcommand comes after it.
for (const command of [
  "pnpm --frozen-lockfile false install",
  "pnpm -r false install",
  "pnpm --prefer-offline false install",
  "pnpm m --frozen-lockfile false i",
  "pnpm -r true add x",
  // A command name held in a variable or substitution is not parsed for options: any later install word fails.
  "$PNPM -w install",
  "${PNPM} -w i",
  "$PNPM -w add ./a",
  "$PNPM --include install",
  "$PNPM --filter x install",
  "$PNPM --dir d install",
  "$PNPM --reporter silent install",
  "$PNPM --frozen-lockfile install",
  "$PNPM install --frozen-lockfile",
  "$(command -v pnpm) -w install",
  "$(command -v pnpm) --frozen-lockfile install",
  "$NPM --workspace x ci",
  "$NPM -g install pnpm@1.2.3",
  "env X=1 $PNPM -w install-test",
  "$PNPM recursive up",
  "$PNPM remove x",
  "$PNPM import",
  // Every alias of both tools, as the tools define them (npm 11.19.0 cmd-list.js, pnpm 10.34.6 command names).
  "npm u",
  "npm udpate x",
  "npm sit",
  "npm clean-install-test",
  "npm isntall-clean",
  "npm installTest",
  "npm cleanInstall",
  "npm upd",
  "npm uninst x",
  "npm in x",
  "npm ins x",
  "npm dd",
  "npm ud",
  "npm si",
  "npm cleanInst",
  "npm r x",
  "npm ddp",
  "npm ln",
  "$NPM u",
  "$NPM sit",
  "$NPM upd",
  "pnpm uni x",
  "pnpm ci",
  "pnpm clean-install",
  "pnpm ic",
  "pnpm install-clean",
  "pnpm it",
  "pnpm install-test",
  "pnpm rm x",
  "pnpm un x",
  "$PNPM uni x",
  "$PNPM ci",
  // A dynamic word before an install word, wherever it is (prefix words such as timeout, chrt, taskset, flock, retry).
  "timeout 60 $PNPM install",
  "timeout -s KILL 60 $PNPM install",
  "timeout 5 env X=1 $PNPM i",
  "chrt 10 $PNPM install",
  "taskset 0x1 $PNPM install",
  "flock /tmp/l $PNPM install",
  "retry 3 $NPM ci",
  "timeout 60 $(which pnpm) add x",
  "nice -n 5 ionice -c 2 $PNPM -w install",
  "timeout 60 ${{ inputs.pm }} install",
  "wrapper-nobody-knows 3 $PNPM install",
  "wrapper-nobody-knows 3 $(which npm) ci",
  "$PNPM dislink",
  // Options that take a value other than true or false are not flags (pnpm 10 and npm 11 option definitions).
  "pnpm --color always install",
  "pnpm --no-color always install",
  "pnpm --link-workspace-packages deep install",
  "pnpm --dev null install",
  "pnpm -D null install",
  "pnpm --production null install",
  "npm --yes null install",
  "npm -y null install",
  "npm --workspaces null install",
  "npm --no-yes null install",
  "pnpm --no-color false install",
  "pnpm -r $VALUE install",
  "pnpm --frozen-lockfile $(echo false) install",
  "pnpm --frozen-lockfile ${{ inputs.frozen }} install",
  "npm --global false install x",
  "npm -g false install x",
  "npm --silent true ci",
  "npm --silent $VALUE ci",
]) {
  runViolation(`${command} fails`, FROZEN, command);
  violation(`${command} in a Dockerfile RUN fails`, DOCKERFILE, FROZEN, "FROM node:24-slim", `RUN ${command}`);
}
runViolation("a flag value true before a substituted command name fails", FROZEN, "$PNPM --frozen-lockfile false install");
runViolation("an option of unknown kind before a command that is no install is read as possibly an install", FROZEN, "pnpm --weird-option exec playwright install");
runViolation("a tool name from an expression fails", PUSH, "${{ inputs.tool }} push x");
runViolation("a package manager name from an expression fails", FROZEN, "${{ env.PM }} install");
runViolation("an expression behind sudo fails", PUSH, "sudo ${{ inputs.tool }} push x");
runViolation("an expression as the tool name with --push later fails", PUSH, "${{ inputs.tool }} buildx build --push .");
// Only true and false are a flag's value (real pnpm reads `-r on install` as the command `on`), so these do not install.
clean("a word other than true or false after a flag is the command, not an install", OTHER, ...pushJob("      - run: pnpm -r on install", "      - run: pnpm -r 0 add x", "      - run: npm --quiet off install x"));
clean("a flag value true before install, with the frozen flag, passes", OTHER, ...pushJob("      - run: pnpm --frozen-lockfile true install", "      - run: pnpm -r true install --frozen-lockfile"));
clean("an expression as an argument or in a word passes", OTHER, ...pushJob("      - run: git push origin ${{ github.ref_name }}", "      - run: docker build -t x:${{ github.sha }} ."));
// The global exemption: a literal -g/--global, no off form, no dynamic word, and every package at an exact version.
for (const command of [
  "npm -g $(echo false) install x",
  "npm --global $(echo false) install x",
  "npm -g $VALUE install x",
  "npm --global ${{ inputs.global }} install x",
  "npm -g ${{ inputs.g }} ci",
  "npm i -g --global=false x@1.2.3",
  "npm i -g x@1.2.3 --global=false",
  "npm i x@1.2.3 -g --global false",
  "npm i --global -g=false x@1.2.3",
  "npm i -g --no-global x@1.2.3",
  "npm i -g --location=project x@1.2.3",
  "npm i -g --location project x@1.2.3",
  "npm i --location=global --global=false x@1.2.3",
  "npm i -g x",
  "npm i -g x@^1",
  "npm i -g x@latest",
  "npm i -g x@1",
  "npm i -g x@1.2",
  "npm i -g ./dir",
  "npm i -g x@1.2.3 y",
  "npm install -g \"pnpm@$VERSION\"",
  "npm install --global $PACKAGE",
  "npm install -g pnpm@${{ inputs.version }}",
  "npm install -g pnpm@1.2.3 $(echo y)",
  "npm install -g --loglevel=$LEVEL pnpm@10.34.6",
  "npm install -g --loglevel=${{ inputs.level }} pnpm@10.34.6",
  "npm ci -g pnpm@1.2.3",
  "npm update -g pnpm@1.2.3",
  "npm install -g",
  "npm install pnpm@1.2.3",
  "npm install pnpm@1.2.3 -- -g",
  "npm --foo bar install -g pnpm@1.2.3",
  // npm's other spellings of a local install, and spellings that only look global (the exemption is an allow-list).
  "npm i -g --local x@1.2.3",
  "npm i -g x@1.2.3 --local",
  "npm i -g -local x@1.2.3",
  "npm i -g --loc x@1.2.3",
  "npm i -g --loca x@1.2.3",
  "npm i -g --no-global=true x@1.2.3",
  "npm --global --local install x@1.2.3",
  "npm install --global --ignore-scripts pnpm@10.34.6 --local",
  "sh -c 'npm i -g --local x@1.2.3'",
  "npm i -reg x@1.2.3",
  "npm i -g yes x@1.2.3",
  "npm i -g true x@1.2.3",
  "npm i -g on x@1.2.3",
  "npm i -gf x@1.2.3",
  "npm i -fg x@1.2.3",
  "npm i -g=true x@1.2.3",
  "npm i -g --global true x@1.2.3",
  "npm i -g --prefix /opt/tools x@1.2.3",
  "npm i -g --save x@1.2.3",
  "npm i -g --foreground-scripts x@1.2.3",
  "npm --silent i -g x@1.2.3",
  "npm i --location project -g x@1.2.3",
  "npm i -g pnpm@1.2.3 -- tool@^1",
  "npm i -g pnpm@1.2.3 -- --local",
]) {
  runViolation(`${command} fails`, FROZEN, command);
  if (!command.startsWith("sh ") && !command.includes("$") && !command.includes("{{")) {
    violation(`${command} in a Dockerfile RUN fails`, DOCKERFILE, FROZEN, "FROM node:24-slim", `RUN ${command}`);
  }
}
violation("a global npm install of a version from a variable fails in a Dockerfile", DOCKERFILE, FROZEN, "FROM node:24-slim", "ARG V", "RUN npm install --global pnpm@${V}");
violation("an off form after -g in a Dockerfile fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN npm i -g --global=false pnpm@10.34.6");
runViolation("npx running a versioned pnpm still fails", FROZEN, "npx -y pnpm@10 install");
runViolation("npm exec running a versioned pnpm still fails", FROZEN, "npm exec pnpm@10 install");
clean("global installs of exact versions pass", OTHER, ...pushJob(
  "      - run: npm install -g pnpm@10.34.6",
  "      - run: npm i --global --ignore-scripts pnpm@10.34.6 typescript@5.9.3",
  "      - run: npm add -g @scope/tool@1.0.0-rc.1",
  "      - run: npm install --global=true pnpm@10.34.6",
  "      - run: npm install --location=global pnpm@10.34.6",
  "      - run: npm install --location global pnpm@10.34.6",
  "      - run: npm install -g pnpm@10.34.6 -- tool@1.2.3",
  "      - run: npm install -g pnpm@10.34.6+build.5",
  "      - run: npm i --ignore-scripts -g x@1.2.3",
  "      - run: npm i -g --ignore-scripts --global x@1.2.3",
));
clean("pnpm recursive install --frozen-lockfile passes", OTHER, ...pushJob("      - run: pnpm recursive install --frozen-lockfile", "      - run: pnpm m i --frozen-lockfile", "      - run: pnpm -r --filter x install --frozen-lockfile"));
clean("--frozen-lockfile with a value true or a path-like word passes", OTHER, ...pushJob("      - run: pnpm install --frozen-lockfile true", "      - run: pnpm install --frozen-lockfile --offline"));
runViolation("npm install --global true is not exempt: true is read as a package", FROZEN, "npm install --global true pnpm@10.34.6");
clean("an assignment with a substitution before a literal pnpm is not a hidden package manager", OTHER, ...pushJob("      - run: X=$(id) pnpm install --frozen-lockfile", '      - run: env "FOO=$X" pnpm install --frozen-lockfile', "      - run: NODE_OPTIONS=${{ inputs.opts }} pnpm install --frozen-lockfile"));
clean("a case statement and prose in quotes are not package manager commands", OTHER, ...pushJob("      - run: |", "          case $rc in", "            0) echo ok ;;", "          esac", "      - run: echo \"Base commit ${BASE_SHA} is not in the checkout\"", "      - run: echo \"Built from $SHA, the image is not pushed\""));
runViolation("a package manager behind timeout in a quoted shell string fails", FROZEN, "sh -c 'timeout 60 $PNPM install'");
runViolation("a package manager behind chrt in a quoted shell string fails", FROZEN, "bash -c 'chrt 10 $PNPM install'");
clean("pnpm commands with substitutions as arguments pass", OTHER, ...pushJob('      - run: pnpm --filter "$PKG" exec vitest run', '      - run: pnpm exec playwright install "$BROWSER"', '      - run: pnpm -C "$DIR" run build'));

clean("pnpm i --frozen-lockfile passes", OTHER, ...pushJob("      - run: pnpm i --frozen-lockfile"));
clean("the flag before the command word and with =true passes", OTHER, ...pushJob("      - run: pnpm -r install --frozen-lockfile=true --offline", "      - run: pnpm --frozen-lockfile install"));
clean("the flag after a line continuation passes", OTHER, ...pushJob("      - run: |", "          pnpm install \\", "            --ignore-scripts \\", "            --frozen-lockfile"));
clean("a quoted flag passes", OTHER, ...pushJob('      - run: pnpm install "--frozen-lockfile"'));
clean("a flagged install in a flow mapping passes", OTHER, ...pushJob('      - {name: x, run: "pnpm install --frozen-lockfile", shell: bash}'));
clean("a flagged install in a folded scalar passes", OTHER, ...pushJob("      - run: >-", "          pnpm install", "          --frozen-lockfile"));
clean("installs joined by && each carrying the flag pass", OTHER, ...pushJob("      - run: cd a && pnpm install --frozen-lockfile && pnpm install --frozen-lockfile --prod"));
clean("a global npm install at an exact version passes", OTHER, ...pushJob("      - run: npm install --global --ignore-scripts pnpm@10.34.6"));
clean("npm i -g and npm install -g pass", DOCKERFILE, "FROM node:24-slim", "RUN npm i -g pnpm@10.34.6", "RUN npm install -g pnpm@10.34.6");
clean("pnpm commands that are not installs pass", OTHER, ...pushJob("      - run: pnpm fetch", "      - run: pnpm exec playwright install chromium", "      - run: pnpm dlx some-tool add", "      - run: pnpm run install-hooks", "      - run: pnpm store path --silent", "      - run: npm exec playwright install", "      - run: npm run build", "      - run: pnpm --filter slugbase exec vitest run", "      - run: pnpm turbo run build --filter=slugbase", "      - run: pnpm audit --audit-level=high"));
clean("pnpm named in a step name, a cache key and an action path passes", OTHER, ...pushJob("      - name: Install pnpm from the lockfile", "      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0", "      - run: echo \"key=pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}\""));
clean("backslashes that are not YAML escapes in a Dockerfile pass", DOCKERFILE, "FROM node:24-slim", "RUN true \\", '  "a\\.b \\$HOME \\q" \\', " && pnpm install --frozen-lockfile --offline");
clean("an install mentioned in a full-line comment passes", OTHER, "on: push", "# pnpm install and npm ci were replaced by the setup action.", "permissions: {}", "jobs: {}");
clean("a Dockerfile inside node_modules is not read", "node_modules/pkg/Dockerfile", "RUN pnpm install");
clean("a test file named like a Dockerfile is not one", "apps/x/dockerfile.test.ts", "// pnpm install", "import { test } from 'vitest';");
clean("apt-get and script installs pass", OTHER, ...pushJob("      - run: apt-get install -y jq", '      - run: bash scripts/scan-image.sh --install "$RUNNER_TEMP/osv-scanner"'));
clean("pnpm install with --frozen-lockfile in a command substitution passes", OTHER, ...pushJob('      - run: echo "$(pnpm install --frozen-lockfile)"'));

// ---- Dockerfiles -----------------------------------------------------------------------

const DOCKER = "dockerfile";

violation("a Dockerfile instruction that cannot be classified fails", DOCKERFILE, DOCKER, "FROM node:24-slim", "RUNN pnpm install --frozen-lockfile");
violation("a Dockerfile line that is no instruction fails", DOCKERFILE, DOCKER, "FROM node:24-slim", "= pnpm install");
violation("an unterminated heredoc fails", DOCKERFILE, DOCKER, "FROM node:24-slim", "RUN <<EOF", "pnpm install --frozen-lockfile");
violation("a SHELL that is not a POSIX shell fails", DOCKERFILE, DOCKER, "FROM node:24-slim", 'SHELL ["powershell", "-command"]');
violation("a SHELL that is no JSON list fails", DOCKERFILE, DOCKER, "FROM node:24-slim", "SHELL /bin/bash -c");
violation("an escape directive other than a backslash or backtick fails", DOCKERFILE, DOCKER, "# escape=^", "FROM node:24-slim");
violation("a heredoc install without the flag fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN <<EOF", "set -e", "pnpm install", "EOF");
violation("a quoted heredoc delimiter is read", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN <<'EOF'", "pnpm install", "EOF");
violation("a <<- heredoc with tab-indented lines is read", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN <<-EOF", "\tpnpm install", "\tEOF");
violation("a heredoc fed to a command is read", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN bash <<EOF", "pnpm add left-pad", "EOF");
violation("two heredocs on one instruction are both read", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN <<A <<B", "true", "A", "pnpm install", "B");
violation("an exec-form install without the flag fails", DOCKERFILE, FROZEN, "FROM node:24-slim", 'RUN ["pnpm", "install"]');
violation("an exec-form shell install without the flag fails", DOCKERFILE, FROZEN, "FROM node:24-slim", 'RUN ["sh", "-c", "pnpm install"]');
violation("an exec-form docker push fails", DOCKERFILE, PUSH, "FROM node:24-slim", 'RUN ["docker", "push", "x"]');
violation("an exec-form shell docker push fails", DOCKERFILE, PUSH, "FROM node:24-slim", 'RUN ["sh","-c","docker push x"]');
violation("a shell-form docker push fails", DOCKERFILE, PUSH, "FROM node:24-slim", "RUN docker push x");
violation("an install after RUN flags fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN --mount=type=cache,target=/root/.local/share/pnpm pnpm install");
violation("an install in ONBUILD RUN fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "ONBUILD RUN pnpm install");
violation("an install in a lower-case run fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "run pnpm install");
violation("an install after a comment line inside a continuation fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN true \\", "  # a comment", "  && pnpm install");
violation("an install after a blank line inside a continuation fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN true \\", "", "  && pnpm install");
violation("an install after a backtick continuation fails", DOCKERFILE, FROZEN, "# escape=`", "FROM node:24-slim", "RUN true `", "  && pnpm install");
violation("an install in CMD fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "CMD pnpm install");
violation("an install in ENTRYPOINT exec form fails", DOCKERFILE, FROZEN, "FROM node:24-slim", 'ENTRYPOINT ["pnpm", "install"]');
violation("an install in HEALTHCHECK CMD fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "HEALTHCHECK --interval=5m CMD pnpm install");
violation("a Dockerfile with CRLF line ends is read", DOCKERFILE, FROZEN, "FROM node:24-slim\r", "RUN pnpm install\r");

violation("an install after several RUN flags with and without values fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN --network=none --security  --mount=type=cache,target=/x pnpm install");
violation("an install after RUN flags separated by tabs fails", DOCKERFILE, FROZEN, "FROM node:24-slim", "RUN\t--mount=type=cache,target=/x\t--network=none\tpnpm install");
violation("a Dockerfile-named document that starts with comments and blank lines then FROM is read", "apps/x/Dockerfile.md", FROZEN, "# a note", "", "  # another", "FROM node:24-slim", "RUN pnpm install");
violation("a Dockerfile-named document that starts with ARG is read", "apps/x/Dockerfile.md", FROZEN, "ARG V=1", "FROM node:24-slim", "RUN pnpm install");
clean("a Dockerfile-named document that does not start like a Dockerfile is not read", "apps/x/Dockerfile.md", "# Building", "", "Run pnpm install first.", "RUN pnpm install");

/**
 * Seconds one check of a tree takes.
 * @param {Record<string, string>} files
 */
function secondsToCheck(files) {
  const dir = tree(files);
  const start = performance.now();
  checkRepository(dir);
  return (performance.now() - start) / 1000;
}

const REPEATS = 30000;
test("repeated flags that never reach a body are checked in linear time", () => {
  for (const flag of ["--A", "--A="]) {
    const seconds = secondsToCheck({ [DOCKERFILE]: y("FROM node:24-slim", `RUN ${flag.repeat(REPEATS)}`, `HEALTHCHECK ${flag.repeat(REPEATS)}`) });
    assert.ok(seconds < 1, `${flag} repeated ${String(REPEATS)} times took ${String(seconds)} s`);
  }
});
test("a Dockerfile-named document of blank lines is checked in linear time", () => {
  for (const blank of ["\n", "\n \n", "\n#\n"]) {
    const seconds = secondsToCheck({ "apps/x/Dockerfile.md": `${blank.repeat(REPEATS)}x\n` });
    assert.ok(seconds < 1, `${JSON.stringify(blank)} repeated ${String(REPEATS)} times took ${String(seconds)} s`);
  }
});

clean("a RUN with a flag and a frozen install passes", DOCKERFILE, "FROM node:24-slim", "RUN --mount=type=cache,target=/x pnpm install --frozen-lockfile");
clean("COPY and ADD heredoc bodies are data", DOCKERFILE, "FROM node:24-slim", "COPY <<EOF /x", "pnpm install", "EOF", "RUN true");
clean("an exec-form CMD passes", DOCKERFILE, "FROM node:24-slim", 'CMD ["server"]', 'ENTRYPOINT ["/app/x.sh"]');
clean("a SHELL naming bash with -o pipefail passes", DOCKERFILE, "FROM node:24-slim", 'SHELL ["/bin/bash", "-o", "pipefail", "-c"]', "RUN pnpm install --frozen-lockfile");
clean("an escape directive of a backtick passes", DOCKERFILE, "# escape=`", "FROM node:24-slim", "RUN pnpm install --frozen-lockfile `", "  --offline");
clean("a syntax directive and comments pass", DOCKERFILE, "# syntax=docker/dockerfile:1", "# note", "FROM node:24-slim", "# RUN pnpm install", "RUN true");
clean("a heredoc without an install passes", DOCKERFILE, "FROM node:24-slim", "RUN <<EOF", "set -e", "echo ok", "EOF");
clean("a Dockerfile of FROM alone passes", "e2e/Dockerfile", "FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f");

// ---- YAML forms --------------------------------------------------------------------------

violation("a parse error fails and names the file", OTHER, YAML, "on: push", "jobs: [", "  b:");
violation("a tab-indent error fails", OTHER, YAML, "on: push", "jobs:", "\tb:", "\t\tsteps: []");
violation("an unknown escape in a double-quoted scalar fails", OTHER, YAML, ...pushJob('      - run: "echo \\q"'));
violation("a short \\x escape in a double-quoted scalar fails", OTHER, YAML, ...pushJob('      - run: "echo \\x4"'));
violation("an unknown escape in a double-quoted key fails", OTHER, YAML, "on:", '  "pull\\-request":', "jobs: {}");
violation("a second document fails", OTHER, YAML, "on: push", "jobs: {}", "---", "on: pull_request", "jobs: {}");
violation("an empty second document fails", OTHER, YAML, "on: push", "jobs: {}", "---");
violation("an empty workflow file fails", OTHER, YAML);
violation("a duplicate key fails", OTHER, YAML, "on: push", "on: pull_request", "jobs: {}");
violation("a duplicate key in a step fails", OTHER, YAML, ...pushJob("      - run: pnpm install --frozen-lockfile", "        run: pnpm install"));
violation("a duplicate key spelled in a quoted form fails", OTHER, YAML, "on: push", '"on": pull_request', "jobs: {}");
violation("keys that differ only in case fail", OTHER, YAML, "on: push", "ON: pull_request", "jobs: {}");
violation("an unresolved alias fails", OTHER, YAML, "on: push", "jobs:", "  b:", "    steps:", "      - run: *cmd");
violation("an alias defined after its use fails", OTHER, YAML, "on: push", "jobs:", "  b:", "    steps:", "      - run: *cmd", "      - run: &cmd pnpm lint");
violation("an excessive alias count fails", OTHER, YAML, "on: push", "x: &a [1, 2]", ...Array.from({ length: 150 }, (_, index) => `x${String(index)}: *a`), "jobs: {}");
violation("a recursive alias fails", OTHER, YAML, "on: push", "x: &a [*a]", "jobs: {}");
violation("an alias to the mapping that holds it fails", OTHER, YAML, "on: push", "x: &a", "  y: *a", "jobs: {}");
violation("a merge key fails", OTHER, YAML, "on: push", "x-step: &s {run: pnpm lint}", "jobs:", "  b:", "    steps:", "      - <<: *s");
violation("a merge key with a list of anchors fails", OTHER, YAML, "on: push", "x-a: &a {run: pnpm lint}", "x-b: &b {name: x}", "jobs:", "  b:", "    steps:", "      - <<: [*a, *b]");
violation("a quoted merge key fails", OTHER, YAML, "on: push", "x: &s {run: a}", "jobs:", "  b:", "    steps:", '      - "<<": *s');
violation("a key that is not a string fails", OTHER, YAML, "on: push", "jobs:", "  b:", "    steps: []", "    1: x");
violation("a complex key fails", OTHER, YAML, "on: push", "? [a, b]", ": c", "jobs: {}");
violation("an unknown tag fails", OTHER, YAML, "on: push", "jobs: !custom {}");
violation("a top-level list is no workflow", OTHER, YAML, "- on: push");
violation("a top-level scalar is no workflow", OTHER, YAML, "just text");
violation("an action that is no mapping fails", ACTION, YAML, "- runs");
violation("an action with a parse error fails", ACTION, YAML, "runs: [", "  using: composite");
violation("an install behind an alias fails", OTHER, FROZEN, "on: push", "x-cmd: &cmd pnpm install", "jobs:", "  b:", "    steps:", "      - run: *cmd");
violation("a push behind an alias to a block scalar fails", OTHER, PUSH, "on: push", "x-cmd: &cmd |", "  docker push x", "jobs:", "  b:", "    steps:", "      - run: *cmd");
violation("a push behind an alias to a whole step fails", OTHER, PUSH, "on: push", "x-step: &s {run: docker push x}", "jobs:", "  b:", "    steps:", "      - *s");
violation("a job behind an alias with an environment fails", PR, SECRETS, "on: pull_request", "x-job: &j {runs-on: x, environment: prod, steps: []}", "jobs:", "  t: *j");
violation("a push in a flow sequence of steps fails", OTHER, PUSH, "on: push", "jobs:", "  b: {steps: [{run: 'docker push x'}]}");
violation("a push in a quoted run key fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    steps:", '      - "run": docker push x');
violation("a push behind an explicit run key fails", OTHER, PUSH, "on: push", "jobs:", "  b:", "    steps:", "      - ? run", "        : docker push x");
violation("a secret behind an explicit key fails", PR, SECRETS, "on: pull_request", "jobs:", "  t:", "    env:", "      ? X", "      : ${{ secrets.NPM_TOKEN }}");
violation("a run that is a list is no form the check reads", OTHER, PUSH, ...pushJob("      - run: [docker, push]"));
violation("shell text nested too deeply fails", OTHER, "internal", ...pushJob(`      - run: ${JSON.stringify(Array.from({ length: 12 }).reduce((text) => `echo $(${String(text)})`, "true"))}`));

clean("an anchored and aliased clean run passes", OTHER, "on: push", "permissions: {}", "x-cmd: &cmd pnpm install --frozen-lockfile", "jobs:", "  b:", "    steps:", "      - run: *cmd", "      - run: *cmd");
clean("flow maps and sequences pass", OTHER, "{on: [push], permissions: {}, jobs: {b: {steps: [{run: 'pnpm install --frozen-lockfile'}]}}}");
clean("quoted keys and an explicit key pass", OTHER, '"on": push', "permissions: {}", "? jobs", ": {b: {steps: [{run: pnpm fetch}]}}");
clean("a block scalar with a keep indicator passes", OTHER, ...pushJob("      - run: |+", "          pnpm install --frozen-lockfile", ""));

// ---- The command tables follow the installed tools ---------------------------------------

// Checked against the tools installed next to this node when their version is the one
// the tables name; with another version (or none) the test is skipped, so a newer tool on
// a runner never fails it. A new version is checked by updating the tables and their version.
const toolsDirectory = join(dirname(process.execPath), "..", "lib", "node_modules");

/** @param {string} name */
function installedVersion(name) {
  try {
    return String(JSON.parse(readFileSync(join(toolsDirectory, name, "package.json"), "utf8")).version);
  } catch {
    return undefined;
  }
}

const npmVersion = installedVersion("npm");
test("the npm command table matches the installed npm", { skip: npmVersion !== COMMAND_TABLES.npm.version && `npm ${String(npmVersion)} is installed, the table is for ${COMMAND_TABLES.npm.version}` }, () => {
  const cmdList = createRequire(import.meta.url)(join(toolsDirectory, "npm", "lib", "utils", "cmd-list.js"));
  const targets = new Set(["install", "install-test", "install-ci-test", "ci", "update", "uninstall", "dedupe", "link"]);
  const names = [...cmdList.commands, ...Object.keys(cmdList.aliases)];
  const prefixes = new Set(names.flatMap((name) => Array.from({ length: name.length }, (_, index) => name.slice(0, index + 1))));
  const resolving = [...prefixes].filter((prefix) => targets.has(cmdList.deref(prefix)));
  const expected = resolving.filter((prefix) => names.includes(prefix) || prefix.length < 3);
  assert.deepEqual([...COMMAND_TABLES.npm.commands].sort(), [...new Set(expected)].sort());
  for (const word of resolving) {
    assert.ok(isNpmInstallOrModifyWord(word), `npm resolves ${word} to ${String(cmdList.deref(word))}`);
  }
  for (const word of ["installTest", "cleanInstall", "installCiTest"]) {
    assert.ok(targets.has(cmdList.deref(word)) && isNpmInstallOrModifyWord(word), word);
  }
});

const pnpmVersion = installedVersion("pnpm");
test("the pnpm command table matches the installed pnpm", { skip: pnpmVersion !== COMMAND_TABLES.pnpm.version && `pnpm ${String(pnpmVersion)} is installed, the table is for ${COMMAND_TABLES.pnpm.version}` }, () => {
  const bundle = readFileSync(join(toolsDirectory, "pnpm", "dist", "pnpm.cjs"), "utf8");
  const groups = [...bundle.matchAll(/exports2\.commandNames = (\[[^\]]*\]);/g)].map((match) => /** @type {string[]} */ (JSON.parse(String(match[1]))));
  const installing = new Set(["add", "install", "install-test", "ci", "dedupe", "link", "remove", "unlink", "update", "import"]);
  const expected = groups.filter((group) => group.some((name) => installing.has(name))).flat();
  assert.deepEqual([...COMMAND_TABLES.pnpm.commands].sort(), [...new Set(expected)].sort());
});

test("the tables do not depend on tools that are absent", () => {
  assert.ok(COMMAND_TABLES.npm.commands.length > 20 && COMMAND_TABLES.pnpm.commands.length > 15);
  assert.ok(existsSync(toolsDirectory) || npmVersion === undefined);
});

// ---- A broken tree fails closed --------------------------------------------------------------

test("a missing .github/workflows folder fails", () => {
  const { findings } = checkRepository(tree({ [RELEASE]: null, [CI]: null, [ACTION]: null }));
  assert.ok(findings.some((finding) => finding.file === ".github/workflows" && finding.rule === "unreadable"), describeFindings(findings));
  rulesWithAViolation.add("unreadable");
});

test("a folder with no workflow fails", () => {
  const dir = tree({ [RELEASE]: null, [CI]: null });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const { findings } = checkRepository(dir);
  assert.ok(findings.some((finding) => finding.file === ".github/workflows"), describeFindings(findings));
});

test("a tree with no composite action passes", () => {
  const { findings } = checkRepository(tree({ [ACTION]: null }));
  assert.deepEqual(findings, [], describeFindings(findings));
});

test("a tree with no release workflow passes", () => {
  const { findings } = checkRepository(tree({ [RELEASE]: null }));
  assert.deepEqual(findings, [], describeFindings(findings));
});

test("a tree with no Dockerfile passes", () => {
  const { findings } = checkRepository(tree({ [DOCKERFILE]: null }));
  assert.deepEqual(findings, [], describeFindings(findings));
});

test("a root that does not exist fails", () => {
  const { findings } = checkRepository(join(tmp, "nothing-here"));
  assert.ok(findings.length > 0);
});

test("an unreadable workflow fails", { skip: process.getuid?.() === 0 && "running as root" }, () => {
  const dir = tree({ ".github/workflows/locked.yml": y("on: push", "jobs: {}") });
  chmodSync(join(dir, ".github/workflows/locked.yml"), 0o000);
  try {
    const { findings } = checkRepository(dir);
    assert.ok(findings.some((finding) => finding.file === ".github/workflows/locked.yml" && finding.rule === "unreadable"), describeFindings(findings));
  } finally {
    chmodSync(join(dir, ".github/workflows/locked.yml"), 0o644);
  }
});

test("an unreadable Dockerfile fails", { skip: process.getuid?.() === 0 && "running as root" }, () => {
  const dir = tree({ "docker/Dockerfile.locked": y("FROM node:24-slim") });
  chmodSync(join(dir, "docker/Dockerfile.locked"), 0o000);
  try {
    const { findings } = checkRepository(dir);
    assert.ok(findings.some((finding) => finding.file === "docker/Dockerfile.locked" && finding.rule === "unreadable"), describeFindings(findings));
  } finally {
    chmodSync(join(dir, "docker/Dockerfile.locked"), 0o644);
  }
});

test("an unreadable folder under .github/actions fails", { skip: process.getuid?.() === 0 && "running as root" }, () => {
  const dir = tree({ ".github/actions/locked/action.yml": y("runs:", "  using: composite") });
  chmodSync(join(dir, ".github/actions/locked"), 0o000);
  try {
    const { findings } = checkRepository(dir);
    assert.ok(findings.some((finding) => finding.rule === "unreadable"), describeFindings(findings));
  } finally {
    chmodSync(join(dir, ".github/actions/locked"), 0o755);
  }
});

test("a symbolic link to nothing named like a Dockerfile fails", () => {
  const dir = tree();
  symlinkSync(join(dir, "target-missing"), join(dir, "Dockerfile.link"));
  const { findings } = checkRepository(dir);
  assert.ok(findings.some((finding) => finding.file === "Dockerfile.link" && finding.rule === "unreadable"), describeFindings(findings));
});

// ---- The command line --------------------------------------------------------------------------

/** @param {string} root */
function run(root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: 60_000 });
}

test("the command exits 0 and says so for a clean tree", () => {
  const result = run(tree());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workflow-policy passed/);
  assert.equal(result.stderr, "");
});

test("the command exits 1 and names the file and the rule for a violation", () => {
  const result = run(tree({ [OTHER]: y(...pushJob("      - run: docker push x")) }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^workflow-policy: \.github\/workflows\/other\.yml: image-push: /m);
});

test("the command exits non-zero for a folder that does not exist", () => {
  const result = run(join(tmp, "nothing-here"));
  assert.notEqual(result.status, 0);
});

test("the command with no argument passes on the repository", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
});

// ---- The builder and the SBOM generator are pinned by digest --------------------------

const IMAGES = "pinned-build-images";
const DIGEST = "sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe";

runViolation("a builder with no image named fails", IMAGES, "docker buildx create --name release --driver docker-container --use");
runViolation("a builder with no image named fails in release.yml", IMAGES, "docker buildx create --name release --driver docker-container --use", RELEASE);
runViolation("a builder with no image named fails in ci.yml", IMAGES, "docker buildx create --name image-scan --driver docker-container --use", CI);
runViolation("a builder image named by tag only fails", IMAGES, "docker buildx create --driver-opt image=moby/buildkit:v0.34.2 --use");
runViolation("a builder image named with no tag or digest fails", IMAGES, "docker buildx create --driver-opt image=moby/buildkit --use");
runViolation("a builder image with a short digest fails", IMAGES, "docker buildx create --driver-opt image=moby/buildkit:v0.34.2@sha256:c5f8862f --use");
runViolation("a builder image with an upper-case digest fails", IMAGES, `docker buildx create --driver-opt image=moby/buildkit:v0.34.2@sha256:${"C5F8862F52499773AF85BC07695B2379EF08E8002352B0DF2C4864C91D78DABE"} --use`);
runViolation("a builder image with a digest and no name fails", IMAGES, `docker buildx create --driver-opt image=@${DIGEST} --use`);
runViolation("a builder image from a parameter fails", IMAGES, 'docker buildx create --driver-opt "image=$BUILDKIT_IMAGE" --use');
runViolation("a builder image from an expression fails", IMAGES, "docker buildx create --driver-opt image=${{ vars.BUILDKIT }} --use");
runViolation("driver options with no image fail", IMAGES, "docker buildx create --driver-opt network=host --use");
runViolation("a pinned image beside an unpinned one fails", IMAGES, `docker buildx create --driver-opt image=${BUILDKIT} --driver-opt image=moby/buildkit:latest --use`);
runViolation("an unpinned image after a pinned one in one option fails", IMAGES, `docker buildx create --driver-opt "image=${BUILDKIT},image=moby/buildkit:latest" --use`);
runViolation("an upper-case option key is read as the image", IMAGES, "docker buildx create --driver-opt IMAGE=moby/buildkit:latest --use");
runViolation("the docker-buildx plugin name is read", IMAGES, "docker-buildx create --use");
runViolation("a path to the plugin is read", IMAGES, "/usr/libexec/docker/cli-plugins/docker-buildx create --use");
runViolation("a builder named before create is read", IMAGES, "docker buildx --builder other create --use");
runViolation("create after a debug flag is read", IMAGES, "docker buildx -D create --use");
runViolation("a builder created behind sudo is read", IMAGES, "sudo docker buildx create --use");
runViolation("a subcommand that cannot be read fails", IMAGES, 'docker buildx "$SUB" --use');
runViolation("a builder created in sh -c is read", IMAGES, "sh -c 'docker buildx create --use'");
violation("a builder created in a Dockerfile RUN is read", DOCKERFILE, IMAGES, "FROM node:24-slim", "RUN docker buildx create --use");
clean("a builder pinned by digest passes", OTHER, ...pushJob(`      - run: docker buildx create --name release --driver docker-container --driver-opt image=${BUILDKIT} --use`));
clean("a builder pinned in the --driver-opt=image= form passes", OTHER, ...pushJob(`      - run: docker buildx create --driver-opt=image=${BUILDKIT} --use`));
clean("a builder pinned beside other driver options passes", OTHER, ...pushJob(`      - run: docker buildx create --driver-opt "network=host,image=${BUILDKIT}" --use`));
clean("a builder pinned over several lines passes", OTHER, ...pushJob("      - run: |", "          docker buildx create \\", "            --name release \\", `            --driver-opt image=${BUILDKIT} \\`, "            --use"));
clean("other buildx commands need no builder image", OTHER, ...pushJob("      - run: docker buildx ls", "      - run: docker buildx inspect --bootstrap", "      - run: docker buildx rm release", "      - run: docker buildx use release"));
clean("the word create after another subcommand is not a builder", OTHER, ...pushJob("      - run: docker buildx inspect create"));

runViolation("an SBOM build with no generator fails", IMAGES, "docker buildx build --sbom=true --output type=local,dest=out .");
runViolation("an SBOM build with no generator fails in release.yml", IMAGES, "docker buildx build --sbom=true --provenance=mode=max --push .", RELEASE);
runViolation("an SBOM build with no generator fails in ci.yml", IMAGES, "docker buildx build --sbom=true --output type=local,dest=out .", CI);
runViolation("a bare --sbom fails", IMAGES, "docker buildx build --sbom --output type=local,dest=out .");
runViolation("--sbom with a separate true fails", IMAGES, "docker buildx build --sbom true --output type=local,dest=out .");
runViolation("a generator named by tag only fails", IMAGES, "docker buildx build --sbom=generator=docker/buildkit-syft-scanner:1.12.1 .");
runViolation("a generator named with no tag or digest fails", IMAGES, "docker buildx build --sbom=generator=docker/buildkit-syft-scanner .");
runViolation("a generator from a parameter fails", IMAGES, 'docker buildx build "--sbom=generator=$GENERATOR" .');
runViolation("a generator from an expression fails", IMAGES, "docker buildx build --sbom=generator=${{ vars.GENERATOR }} .");
runViolation("SBOM options with no generator fail", IMAGES, "docker buildx build --sbom=disabled=false .");
runViolation("a generator beside an unpinned one fails", IMAGES, `docker buildx build "--sbom=generator=${GENERATOR},generator=docker/buildkit-syft-scanner:1" .`);
runViolation("--attest type=sbom with no generator fails", IMAGES, "docker buildx build --attest type=sbom .");
runViolation("--attest=type=sbom with no generator fails", IMAGES, "docker buildx build --attest=type=sbom .");
runViolation("an SBOM attestation behind a provenance one fails", IMAGES, "docker buildx build --attest type=provenance,mode=max --attest type=sbom .");
runViolation("an attestation with an unpinned generator fails", IMAGES, "docker buildx build --attest type=sbom,generator=docker/buildkit-syft-scanner:1 .");
runViolation("an upper-case attestation type is read", IMAGES, "docker buildx build --attest TYPE=SBOM .");
runViolation("docker build is read like docker buildx build", IMAGES, "docker build --sbom=true -t x .");
runViolation("an SBOM build behind sudo is read", IMAGES, "sudo docker buildx build --sbom=true .");
violation("an SBOM build over several lines fails", OTHER, IMAGES, ...pushJob("      - run: |", "          docker buildx build \\", "            --file apps/slugbase/Dockerfile \\", "            --sbom=true \\", "            .", "          true"));
violation("an SBOM build in a Dockerfile RUN is read", DOCKERFILE, IMAGES, "FROM node:24-slim", "RUN docker buildx build --sbom=true .");
clean("a generator pinned by digest passes", OTHER, ...pushJob(`      - run: docker buildx build --sbom=generator=${GENERATOR} --output type=local,dest=out .`));
clean("a generator pinned in an attestation passes", OTHER, ...pushJob(`      - run: docker buildx build --attest type=sbom,generator=${GENERATOR} --attest type=provenance,mode=max .`));
clean("a generator pinned in the --attest= form passes", OTHER, ...pushJob(`      - run: docker buildx build --attest=type=sbom,generator=${GENERATOR} .`));
clean("a generator pinned beside other SBOM options passes", OTHER, ...pushJob(`      - run: docker buildx build "--sbom=scan-context=true,generator=${GENERATOR}" .`));
clean("a build with the SBOM turned off passes", OTHER, ...pushJob("      - run: docker buildx build --sbom=false --provenance=false ."));
clean("a build with no SBOM option passes", OTHER, ...pushJob("      - run: docker buildx build --provenance=mode=max --output type=docker ."));
clean("an --sbom flag of another tool passes", OTHER, ...pushJob("      - run: syft --sbom=true ."));

const SETUP_BUILDX = "docker/setup-buildx-action@0000000000000000000000000000000000000000";
const BUILD_ACTION = "docker/build-push-action@0000000000000000000000000000000000000000";
violation("setup-buildx-action with no driver options fails", OTHER, IMAGES, ...pushJob(`      - uses: ${SETUP_BUILDX}`));
violation("setup-buildx-action with an unpinned builder image fails", OTHER, IMAGES, ...pushJob(`      - uses: ${SETUP_BUILDX}`, "        with:", "          driver-opts: image=moby/buildkit:latest"));
violation("setup-buildx-action with other driver options only fails", OTHER, IMAGES, ...pushJob(`      - uses: ${SETUP_BUILDX}`, "        with:", "          driver-opts: network=host"));
violation("setup-buildx-action with a pinned and an unpinned image on two lines fails", OTHER, IMAGES, ...pushJob(`      - uses: ${SETUP_BUILDX}`, "        with:", "          driver-opts: |", `            image=${BUILDKIT}`, "            image=moby/buildkit:latest"));
violation("setup-buildx-action with an image from an expression fails", OTHER, IMAGES, ...pushJob(`      - uses: ${SETUP_BUILDX}`, "        with:", "          driver-opts: image=${{ vars.BUILDKIT }}"));
clean("setup-buildx-action with a builder image pinned by digest passes", OTHER, ...pushJob(`      - uses: ${SETUP_BUILDX}`, "        with:", "          driver-opts: |", "            network=host", `            image=${BUILDKIT}`));
violation("an action with sbom: true and no generator fails", OTHER, IMAGES, ...pushJob(`      - uses: ${BUILD_ACTION}`, "        with:", "          sbom: true"));
violation("an action with sbom: true and no generator fails in release.yml", RELEASE, IMAGES, "on:", "  push:", "    branches: [main]", "permissions: {}", "jobs:", "  b:", "    runs-on: ubuntu-latest", "    steps:", `      - uses: ${BUILD_ACTION}`, "        with:", "          sbom: true");
violation("an action with an unpinned sbom generator fails", OTHER, IMAGES, ...pushJob(`      - uses: ${BUILD_ACTION}`, "        with:", "          sbom: generator=docker/buildkit-syft-scanner:1"));
violation("an action with an sbom attestation and no generator fails", OTHER, IMAGES, ...pushJob(`      - uses: ${BUILD_ACTION}`, "        with:", "          attests: |", "            type=provenance,mode=max", "            type=sbom"));
violation("an action with sbom set by an expression fails", OTHER, IMAGES, ...pushJob(`      - uses: ${BUILD_ACTION}`, "        with:", "          sbom: ${{ vars.SBOM }}"));
clean("an action with sbom: false passes", OTHER, ...pushJob(`      - uses: ${BUILD_ACTION.replace("build-push", "bake")}`, "        with:", "          sbom: false"));
clean("an action with a pinned sbom generator passes", OTHER, ...pushJob(`      - uses: ${BUILD_ACTION.replace("build-push", "bake")}`, "        with:", `          sbom: generator=${GENERATOR}`));
clean("an action with a pinned sbom attestation passes", OTHER, ...pushJob(`      - uses: ${BUILD_ACTION.replace("build-push", "bake")}`, "        with:", "          attests: |", "            type=provenance,mode=max", `            type=sbom,generator=${GENERATOR}`));

// ---- A workflow declares its token permissions ----------------------------------------

const DECLARED = "permissions-declared";

violation("a push-triggered workflow with no permissions anywhere fails", OTHER, DECLARED, "on: push", "jobs:", "  b:", "    runs-on: ubuntu-latest", "    steps:", "      - run: pnpm lint");
violation("a workflow with no permissions and no job fails", OTHER, DECLARED, "on: push", "jobs: {}");
violation("a workflow with permissions on one of two jobs fails", OTHER, DECLARED, "on: push", "jobs:", "  a:", "    permissions: {}", "    steps: []", "  b:", "    steps: []");
violation("a workflow with permissions on only the second of two jobs fails", OTHER, DECLARED, "on: push", "jobs:", "  a:", "    steps: []", "  b:", "    permissions: {}", "    steps: []");
violation("a workflow whose permissions key is empty fails", OTHER, DECLARED, "on: push", "permissions:", "jobs:", "  b:", "    steps: []");
violation("a workflow whose job permissions key is empty fails", OTHER, DECLARED, "on: push", "jobs:", "  b:", "    permissions:", "    steps: []");
violation("a pull_request workflow with no permissions fails", PR, DECLARED, "on: pull_request", "jobs:", "  t:", "    steps:", "      - run: pnpm lint");
violation("a workflow whose jobs are no mapping fails", OTHER, DECLARED, "on: push", "jobs: []");
violation("a workflow whose job is no mapping fails", OTHER, DECLARED, "on: push", "jobs:", "  b: build");
violation("release.yml with no permissions fails", RELEASE, DECLARED, "on:", "  push:", "    branches: [main]", "jobs:", "  b:", "    steps:", "      - run: docker buildx build --push .");
violation("a workflow with a permissions key only under a step fails", OTHER, DECLARED, "on: push", "jobs:", "  b:", "    steps:", "      - run: pnpm lint", "        with:", "          permissions: read-all");
clean("a workflow with top-level permissions passes", OTHER, "on: push", "permissions:", "  contents: read", "jobs:", "  b:", "    steps:", "      - run: pnpm lint");
clean("a workflow with empty top-level permissions passes", OTHER, "on: push", "permissions: {}", "jobs:", "  b:", "    steps:", "      - run: pnpm lint");
clean("a workflow with read-all passes", OTHER, "on: push", "permissions: read-all", "jobs:", "  b:", "    steps:", "      - run: pnpm lint");
clean("a workflow with permissions on every job passes", OTHER, "on: push", "jobs:", "  a:", "    permissions: {}", "    steps: []", "  b:", "    permissions:", "      contents: read", "    steps: []");
clean("a workflow with a quoted permissions key on every job passes", OTHER, "on: push", "jobs:", "  a:", '    "permissions": {}', "    steps: []");
clean("a job that calls a reusable workflow and declares permissions passes", OTHER, "on: push", "jobs:", "  a:", "    permissions:", "      contents: read", "    uses: ./.github/workflows/other.yml");
clean("a composite action needs no permissions", ".github/actions/other/action.yml", "name: Other", "description: x", "runs:", "  using: composite", "  steps:", "    - shell: bash", "      run: echo hi");

// ---- Every rule has a case that fails it ----------------------------------------------------------

test("every rule of the check has a violation case", () => {
  const missing = RULES.filter((rule) => !rulesWithAViolation.has(rule));
  assert.deepEqual(missing, [], `no violation case reaches: ${missing.join(", ")}`);
});
