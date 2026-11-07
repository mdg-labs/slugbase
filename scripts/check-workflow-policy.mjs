// Checks the pipeline rules of threat T16 (doc 10 section 4) that
// scripts/check-workflow-triggers.sh does not hold:
//
//   node scripts/check-workflow-policy.mjs [repository root]
//
// - pull-request-secrets: a workflow a pull request can start (its parsed `on`
//   names pull_request*, pull_request_target, workflow_run, issue_comment or
//   workflow_call) reads no secret but the workflow token, in any spelling of
//   the `secrets` context, uses no `secrets: inherit` and names no `environment`.
// - image-push: only .github/workflows/release.yml pushes an image (a command below,
//   an action whose name holds the word push, a `with:` input push that is not false,
//   or an input with push= (not false or 0) or type=registry) or holds `packages:`
//   above read, and
//   write-all is held nowhere.
// - permissions-declared: a workflow declares `permissions` at its top level or on
//   every one of its jobs (a null value does not count), so the repository's default
//   token permissions never apply to it. A composite action has no token of its own.
// - pinned-build-images: every `docker buildx create` names its builder image with
//   `--driver-opt image=<name>[:<tag>]@sha256:<64 hex digits>`, and every build that
//   asks for an SBOM (`--sbom`, or `--attest` with type=sbom) names its generator with
//   `generator=<name>[:<tag>]@sha256:<64 hex digits>`, so the program that builds, and
//   the one that writes the SBOM the scan gate reads, do not come from a floating
//   upstream tag. The setup-buildx-action input driver-opts and the sbom and attests
//   inputs of an action are held to the same rule. An image from a parameter, a
//   substitution or an expression fails, since its digest cannot be read.
// - local-action: every `uses: ./<path>` of a workflow or composite action, wherever the
//   path points, names a workflow under .github/workflows or a folder with an
//   action.yml or action.yaml, which is then read as a composite action like those under
//   .github/actions (so its `run:` steps are held to the rules below). A path that is
//   missing, leaves the repository or holds an expression or parameter fails.
// - dockerfile: a build command (`docker build`, `buildx build`, `podman build`) whose
//   -f or --file, or a build-push-action `file:` input, names a file that is not named like
//   a Dockerfile (Dockerfile, Containerfile or *.Dockerfile, as the list of files this
//   check reads), so the file the image is built from is always one of those it reads.
// - release-triggers: release.yml runs on a push with `branches: [main]` and/or a
//   release with `types: [published]` and on nothing else.
// - frozen-lockfile: every pnpm install (install, i, install-test, it, ci and their
//   aliases) carries --frozen-lockfile; no pnpm add, update, up, upgrade, dedupe,
//   import, remove, rm, uninstall, un, uni, link, ln, unlink or dislink; no npm
//   install, install-test, install-ci-test, ci, update, uninstall, dedupe or link
//   (with every alias, camelCase spelling and prefix of three letters or more of
//   them) except a global install of exact versions (below); no yarn; and no
//   frozen-lockfile setting through the environment.
//
// It reads .github/workflows/*.yml|yaml, .github/actions/**/action.yml|yaml, every
// local action a workflow or action uses (`uses: ./<path>`, wherever it is) and every
// Dockerfile or Containerfile outside node_modules. A workflow or action is
// read as the parsed value of the `yaml` package, never as text, so the rules do
// not depend on how YAML spells a key or a string (quotes, escapes, flow forms,
// anchors and aliases, explicit keys, folded and plain multi-line scalars). The
// parse fails closed: a parse error or warning, more than one document, a
// duplicate key (also one that differs only in case), a non-string key, an
// unresolved alias, a recursive or excessive alias, and a `<<` merge key (not
// resolved: GitHub's workflow syntax does not define it, so a file that uses it
// is rejected) each fail the file.
//
// Shell text is every `run:` value and every RUN, CMD, ENTRYPOINT and HEALTHCHECK
// instruction of a Dockerfile (shell form, exec form and heredoc). A `${{ }}`
// expression becomes a dynamic word, like a substitution (below). The text is split
// into words the way a POSIX shell reads them: a backslash and a newline are joined; quotes are
// removed and a backslash makes the next character literal (`d\ocker`, "docker"
// and `pu\sh` are the words docker and push); $'...' escapes are decoded;
// comments are dropped; and commands end at `;`, `&`, `|`, `(`, `)` and a
// newline. A quoted word that holds white space or a separator, a $(...) and a
// backtick are read again as shell text, so `sh -c 'docker push x'` is read.
// A word built from a command, arithmetic or backtick substitution, or holding a
// parameter ($X, ${X}), is dynamic (an assignment word such as FOO=$X is not). A
// dynamic word may hide pnpm, npm or a container tool behind any prefix word
// (`timeout 60 $PNPM install`), and the two tools read options differently, so
// options are not parsed there and --frozen-lockfile earns no credit:
//   - in a command with a dynamic word before the first literal pnpm, npm, yarn or yarnpkg
//     word (or with none), any later word that installs or modifies for either tool fails
//     (the pnpm and npm names and aliases listed below, npm's camelCase spellings and
//     its prefixes of three letters or more); the `in` of case, for and select is not
//     one;
//   - a dynamic word before a later word `push` fails, whichever container tool it
//     may be;
//   - in a command read again from a quoted string, which may be prose, only a dynamic
//     command name counts, after assignments and the prefix words command, sudo, doas,
//     env, exec, xargs, nice, ionice, time, nohup, setsid, stdbuf, watch, builtin, eval,
//     !, if, then, else, elif, do, while, until, { and }, and timeout, chrt, taskset,
//     flock and retry (each with its one plain argument).
// `$(which docker) push x`, `$PNPM install --frozen-lockfile`, `$PNPM -w install` and
// `timeout 60 $PNPM install` fail. Each command is then matched on its own, wherever
// its words appear:
//   image push   a container tool word (docker, docker-compose, podman, buildah,
//                nerdctl, ctr) and a later word `push`; --push (not =false);
//                push= (not false or 0); type=registry; -o registry or --output
//                registry; imagetools;
//                skopeo, crane, oras, regctl.
//   installs     pnpm install|i|install-test|it|ci|clean-install|ic|install-clean
//                needs --frozen-lockfile and no
//                --no-frozen-lockfile, =false or a following word false, 0, no,
//                off or a substitution (`--frozen-lockfile false`), and none of
//                --fix-lockfile, --lockfile-only, --no-lockfile, --lockfile=false; pnpm's
//                recursive, multi and m prefixes and its options (with their
//                values) are skipped to find the subcommand, and a subcommand
//                that cannot be told (a substitution, or an option of unknown
//                kind that is followed by no install word, so `npm -v` too)
//                is read as an install; pnpm add|update|up|upgrade|dedupe|import|remove|rm|
//                uninstall|un|uni|link|ln|unlink|dislink fail; npm install and
//                every other npm install or modify command and alias fail
//                (the tables below, camelCase, prefixes of three letters or more)
//                unless it is a global install of exact versions, by allow-list:
//                the subcommand is install, add, i, in, ins, inst, insta, instal,
//                isnt, isnta, isntal or isntall (never ci or update); the
//                only options are -g, --global, --global=true or --location=global
//                (or --location and global as two words), at least one of them,
//                and --ignore-scripts, anywhere in the command; any other word
//                that starts with a dash (--local, --loc, -reg, --no-global, -gf,
//                -g=true, --prefix, ...) makes it not exempt, because npm expands
//                abbreviations and shorthands, and so does a dynamic word; a
//                flag value (`-g true`) is read as a package; every package, also
//                after `--`, is name@x.y.z with an optional pre-release or +build
//                (scope allowed);
//                any yarn or yarnpkg fails; any frozen-lockfile environment variable
//                (PNPM_FROZEN_LOCKFILE, npm_config_frozen_lockfile) fails: any key of
//                a workflow or action file whose name holds frozen_lockfile, a
//                Dockerfile ENV or ARG, or a word of a command.
// A Dockerfile instruction this script cannot classify, JSON that is not what
// its form promises, an unterminated heredoc and a SHELL other than a POSIX shell
// fail the file. An unreadable file or directory and an exception fail the check.
//
// Limits (not read): a whole command held in a variable or an expression (`$CMD`
// alone; a dynamic word is read only with a later push or install word), a dynamic
// command name behind a prefix word this script does not know inside a quoted string
// (`sh -c 'wrapper 3 $PNPM install'`; at the top level of a step any prefix word is
// read), a command renamed by a shell function or an alias, a script a step runs
// (`bash scripts/x.sh`), a `run:` of a custom `shell:` that is not a POSIX shell,
// container tools beyond the list above (ko, kaniko, buildctl, pack, helm),
// installers other than pnpm, npm and yarn, and `run_install` of pnpm/action-setup.
// Known false positives (the check fails, safe): `docker` and a later `push` in one
// command even as quoted text (an echo or a commit message), any dynamic word before a
// word `push` or before an install word of either tool (`git -C "$DIR" push`,
// `echo Updating $X up`, `$MAKE install`, `${{ github.workspace }}/x.sh push`), a
// heredoc body (read as commands), a step that mentions `secrets` in a string that also
// holds an expression in a pull-request workflow, an action whose name holds the word
// push, the words skopeo, crane, oras, regctl, yarn or yarnpkg anywhere in a command,
// an npm install word spelled as a prefix of three letters or more that npm itself does
// not resolve (`npm isn`, `npm cle`; every prefix npm does resolve, such as `npm upd`,
// `npm upg` or `npm lin`, is a true positive and must stay matched), and a pnpm or npm
// command with an option of unknown kind that is followed by no install word
// (`pnpm --some-option exec x`, and `npm -v` or `npm --version`, which have no
// subcommand) or with a substitution as its subcommand. An
// option listed as Boolean (including untyped options nopt reads as Boolean) takes a
// following true or false, and nothing else, as its value, so the subcommand is looked
// for after it; an option that also takes another value (--color always, --yes null) is
// not listed.
//
// Exit status: 0 when the tree follows the policy, 1 when it does not, 2 when
// the check could not run. A finding reads "workflow-policy: <file>: <rule>: ...".
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

/** @typedef {{ file: string, rule: string, message: string }} Finding */
/** @typedef {(rule: string, message: string) => void} Report */

export const RULES = [
  "unreadable",
  "yaml",
  "dockerfile",
  "pull-request-secrets",
  "image-push",
  "permissions-declared",
  "pinned-build-images",
  "release-triggers",
  "frozen-lockfile",
  "local-action",
  "internal",
];

const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const MAX_NESTING = 8;
const MAX_ALIASES = 100;

// Events a pull request, a comment or a caller can start. pull_request_review and
// pull_request_review_comment are started by a pull request as well.
const STARTABLE_EVENT = /^(pull_request(_[a-z_]+)?|workflow_run|issue_comment|workflow_call)$/;

const CONTAINER_TOOLS = new Set(["docker", "docker-compose", "podman", "buildah", "nerdctl", "ctr"]);
const REGISTRY_TOOLS = new Set(["skopeo", "crane", "oras", "regctl"]);
const YARN_TOOLS = new Set(["yarn", "yarnpkg"]);

// Options that take the next word as their value, and flags: options that take
// no value or only true or false (and the shorthands that expand to a value of
// their own). Only options that are Boolean, including untyped options nopt reads as Boolean, count as flags; one that also
// takes another value (pnpm's --color always, --link-workspace-packages deep,
// --dev null, npm's --yes null, --workspaces null) is not a flag. A word after any
// other option may be its value or the subcommand, so it is read as both. The
// lists follow the option definitions of pnpm 10.34.6 (the types table of
// dist/pnpm.cjs) and npm 11.19.0 (@npmcli/config definitions and shorthands).
const PNPM_VALUE_OPTIONS = new Set(
  "-C --dir -F --filter --filter-prod --workspace-concurrency --reporter --loglevel --store-dir --registry --network-concurrency --child-concurrency --lockfile-dir --modules-dir --virtual-store-dir --package-import-method --node-linker --test-pattern --changed-files-ignore-pattern --use-node-version --config --prefix --userconfig --global-dir --global-bin-dir --cache-dir --state-dir --fetch-timeout --fetch-retries --pnpmfile --global-pnpmfile --public-hoist-pattern --hoist-pattern --resolution-mode".split(" "),
);
const PNPM_FLAGS = new Set("--version -v --help -h --bail --aggregate-output --sort --fail-if-no-match --ignore-workspace --ignore-workspace-root-check --use-stderr --shamefully-hoist --strict-peer-dependencies --prefer-frozen-lockfile --ignore-pnpmfile --hoist --force -f --dry-run -r --recursive -w --workspace-root --silent -s --offline --prefer-offline --frozen-lockfile --ignore-scripts --global -g --stream --parallel --if-present".split(" "));
const NPM_VALUE_OPTIONS = new Set(
  "--prefix -C --workspace -w --userconfig --globalconfig --registry --cache --loglevel --scope --tag --otp --before --omit --include --install-strategy --location --logs-dir --logs-max --fetch-retries --fetch-timeout --lockfile-version -c --call --node-options --cafile --proxy --https-proxy --noproxy --init-module".split(" "),
);
const NPM_FLAGS = new Set("-g --global --save -S --save-dev -D --save-optional -O --ignore-scripts --legacy-peer-deps --force -f --silent -s --quiet -q --verbose --offline --prefer-offline --prefer-online --include-workspace-root --dry-run --json".split(" "));
// pnpm runs the next subcommand for each package of the workspace after these.
const PNPM_PREFIXES = new Set(["recursive", "multi", "m"]);
// The install and modify commands, as the tools define them: pnpm 10.34.6 (the
// commandNames of dist/pnpm.cjs; pnpm resolves exact names and aliases only) and
// npm 11.19.0 (lib/utils/cmd-list.js: install, install-test, install-ci-test, ci,
// update, uninstall, dedupe and link with every alias that derefs to them, and the
// two-letter prefixes that npm resolves to them: dd, ud, si). The test compares both
// lists with the installed tools only when their versions match the ones named here;
// in CI it is skipped (the lint container's npm differs from the table's version, and
// pnpm comes from pnpm/action-setup), so these tables are the rule there.
const PNPM_INSTALL = new Set("install i install-test it ci clean-install ic install-clean".split(" "));
const PNPM_MODIFY = new Set("add update up upgrade dedupe import remove rm uninstall un uni link ln unlink dislink".split(" "));
const NPM_INSTALL_OR_MODIFY = "install add i in ins inst insta instal isnt isnta isntal isntall install-test it install-ci-test cit clean-install-test sit ci clean-install ic install-clean isntall-clean update up upgrade udpate u uninstall unlink remove rm r un dedupe ddp link ln dd ud si".split(" ");
export const COMMAND_TABLES = {
  pnpm: { version: "10.34.6", commands: [...PNPM_INSTALL, ...PNPM_MODIFY].sort() },
  npm: { version: "11.19.0", commands: [...NPM_INSTALL_OR_MODIFY].sort() },
};

/**
 * True when npm would read the word as an install or modify command: npm accepts
 * camelCase (installTest) and any unique prefix of a command or alias (upd, uninst),
 * so this is true for a prefix of any of them, which is stricter and fails safe. A
 * prefix needs three letters: the shorter ones that npm resolves to an install command
 * are aliases of the list (the test checks this against the installed npm).
 * @param {string} word
 */
export function isNpmInstallOrModifyWord(word) {
  const name = word.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
  return NPM_INSTALL_OR_MODIFY.includes(name) || (name.length >= 3 && NPM_INSTALL_OR_MODIFY.some((command) => command.startsWith(name)));
}

/** @param {string} word */
const isInstallOrModifyWord = (word) => PNPM_INSTALL.has(word) || PNPM_MODIFY.has(word) || isNpmInstallOrModifyWord(word);

class PolicyError extends Error {
  /**
   * @param {string} rule
   * @param {string} message
   */
  constructor(rule, message) {
    super(message);
    this.rule = rule;
  }
}

/** @param {unknown} value */
const isMap = (value) => value instanceof Map;

/** @param {unknown} key */
const lower = (key) => (typeof key === "string" ? key.toLowerCase() : "");

/**
 * The value of a mapping key, compared without case (keys that differ only in case are rejected).
 * @param {unknown} map
 * @param {string} name
 */
function get(map, name) {
  if (!isMap(map)) {
    return undefined;
  }
  for (const [key, value] of map) {
    if (lower(key) === name) {
      return value;
    }
  }
  return undefined;
}

/** @param {unknown} map @param {string} name */
function has(map, name) {
  return isMap(map) && [...map.keys()].some((key) => lower(key) === name);
}

/** @param {unknown} value */
function show(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// ---- YAML ---------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {{ value: unknown, errors: string[] }}
 */
function loadYaml(text) {
  const documents = parseAllDocuments(text, {
    uniqueKeys: true,
    merge: false,
    strict: true,
    version: "1.2",
    maxAliasCount: MAX_ALIASES,
  });
  /** @type {string[]} */
  const errors = [];
  if (documents.length === 0) {
    return { value: undefined, errors: ["the file holds no YAML document"] };
  }
  if (documents.length > 1) {
    errors.push(`the file holds ${String(documents.length)} YAML documents, not one`);
  }
  for (const document of documents) {
    for (const error of document.errors) {
      errors.push(error.message.split("\n")[0] ?? error.message);
    }
    for (const warning of document.warnings) {
      errors.push(`warning: ${warning.message.split("\n")[0] ?? warning.message}`);
    }
  }
  if (errors.length > 0) {
    return { value: undefined, errors };
  }
  try {
    const value = documents[0]?.toJS({ mapAsMap: true, maxAliasCount: MAX_ALIASES });
    return { value, errors: validateTree(value) };
  } catch (error) {
    return { value: undefined, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/**
 * Rejects what the rules cannot read: a non-string key, a merge key, keys that differ
 * only in case, and a value that contains itself.
 * @param {unknown} root
 * @returns {string[]}
 */
function validateTree(root) {
  /** @type {Set<string>} */
  const errors = new Set();
  /** @param {unknown} node @param {Set<unknown>} ancestors */
  const visit = (node, ancestors) => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (ancestors.has(node)) {
      errors.add("an alias refers to the collection that holds it");
      return;
    }
    ancestors.add(node);
    if (isMap(node)) {
      const seen = new Set();
      for (const [key, value] of node) {
        if (typeof key !== "string") {
          errors.add(`a mapping key that is not a string: ${show(key)}`);
        } else if (key === "<<") {
          errors.add("a `<<` merge key (not defined by the workflow syntax, so not read)");
        } else if (seen.has(key.toLowerCase())) {
          errors.add(`the key ${show(key)} twice (keys differing only in case count as one)`);
        } else {
          seen.add(key.toLowerCase());
        }
        visit(value, ancestors);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, ancestors);
      }
    }
    ancestors.delete(node);
  };
  visit(root, new Set());
  return [...errors];
}

/**
 * Calls onMap for every mapping and onString for every string, keys included.
 * @param {unknown} root
 * @param {(map: Map<string, unknown>) => void} onMap
 * @param {(text: string, key: string | undefined) => void} onString
 */
function walk(root, onMap, onString) {
  /** @param {unknown} node @param {string | undefined} key */
  const visit = (node, key) => {
    if (typeof node === "string") {
      onString(node, key);
    } else if (isMap(node)) {
      onMap(node);
      for (const [name, value] of node) {
        onString(String(name), undefined);
        visit(value, lower(name));
      }
    } else if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, key);
      }
    }
  };
  visit(root, undefined);
}

// ---- GitHub expressions ---------------------------------------------------------

/**
 * Replaces every ${{ ... }} by the marker of a dynamic word. The end is the first `}}`
 * outside a string literal, so a literal holding `}}` cannot end it early.
 * @param {string} text
 */
function withoutExpressions(text) {
  let out = "";
  let at = 0;
  for (;;) {
    const start = text.indexOf("${{", at);
    if (start < 0) {
      return out + text.slice(at);
    }
    let end = -1;
    let inString = false;
    for (let i = start + 3; i < text.length; i += 1) {
      if (text[i] === "'") {
        inString = !inString;
      } else if (!inString && text[i] === "}" && text[i + 1] === "}") {
        end = i + 2;
        break;
      }
    }
    if (end < 0) {
      // Not an expression GitHub would accept: read the rest as written.
      return out + text.slice(at);
    }
    out += `${text.slice(at, start)}${SUBSTITUTION}`;
    at = end;
  }
}

/**
 * True when the text names the secrets context other than as secrets.GITHUB_TOKEN.
 * @param {string} text
 */
function readsOtherSecret(text) {
  for (const match of text.matchAll(/\bsecrets\b/gi)) {
    const rest = text.slice(match.index + match[0].length);
    const token = /^\s*\.\s*github_token(?![A-Za-z0-9_-])/i.test(rest) || /^\s*\[\s*(['"])github_token\1\s*\]/i.test(rest);
    if (!token) {
      return true;
    }
  }
  return false;
}

// ---- Shell text -----------------------------------------------------------------

// What a command, arithmetic or backtick substitution leaves in its word: the
// result is unknown, so a word that holds it (or a parameter, $X) is dynamic.
const SUBSTITUTION = "<subst>";
const DYNAMIC_WORD = /<subst>|\$/;
// The commands read again from a quoted word, which may be prose (`echo "$X is not in the tree"`).
const RESCANNED = new WeakSet();
const NEEDS_READING_AGAIN = /[\s;&|`]|\$\(/;

/**
 * The index of the `)` that closes a `$(` whose body starts at `from`, or the end.
 * @param {string} text
 * @param {number} from
 */
function closingParen(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length;
}

/**
 * The index of the closing backtick of a body that starts at `from`, or the end.
 * @param {string} text
 * @param {number} from
 */
function closingBacktick(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === "`") {
      return i;
    }
  }
  return text.length;
}

const ANSI_C_SIMPLE = { n: "\n", t: "\t", r: "\r", a: "\u0007", b: "\b", e: "\u001b", E: "\u001b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * Decodes the body of $'...' that starts at `from`.
 * @param {string} text
 * @param {number} from
 * @returns {{ value: string, end: number }}
 */
function ansiC(text, from) {
  let value = "";
  let i = from;
  while (i < text.length && text[i] !== "'") {
    if (text[i] !== "\\") {
      value += text[i];
      i += 1;
      continue;
    }
    const next = text[i + 1] ?? "";
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i + 1)) ?? /^u([0-9a-fA-F]{1,4})/.exec(text.slice(i + 1)) ?? /^U([0-9a-fA-F]{1,8})/.exec(text.slice(i + 1));
    const octal = /^([0-7]{1,3})/.exec(text.slice(i + 1));
    if (hex?.[1] !== undefined) {
      value += String.fromCodePoint(Number.parseInt(hex[1], 16));
      i += 1 + hex[0].length;
    } else if (octal?.[1] !== undefined) {
      value += String.fromCodePoint(Number.parseInt(octal[1], 8));
      i += 1 + octal[0].length;
    } else if (next in ANSI_C_SIMPLE) {
      value += ANSI_C_SIMPLE[/** @type {keyof typeof ANSI_C_SIMPLE} */ (next)];
      i += 2;
    } else {
      value += `\\${next}`;
      i += 2;
    }
  }
  return { value, end: i + 1 };
}

/**
 * Splits shell text into commands, each a list of words.
 * @param {string} text
 * @param {number} [depth]
 * @returns {string[][]}
 */
function shellCommands(text, depth = 0) {
  if (depth > MAX_NESTING) {
    throw new PolicyError("internal", "shell text nested too deeply to read");
  }
  const src = text.replace(/\r\n?/g, "\n");
  /** @type {string[][]} */
  const commands = [];
  /** @type {string[][]} */
  const nested = [];
  /** @type {string[]} */
  let words = [];
  /** @type {string | null} */
  let word = null;
  let marked = false;

  const endWord = () => {
    if (word !== null) {
      words.push(word);
      if (marked && NEEDS_READING_AGAIN.test(word)) {
        for (const command of shellCommands(word, depth + 1)) {
          RESCANNED.add(command);
          nested.push(command);
        }
      }
    }
    word = null;
    marked = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) {
      commands.push(words);
    }
    words = [];
  };
  /** @param {string} piece */
  const add = (piece) => {
    word = (word ?? "") + piece;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    if (c === "\\") {
      const next = src[i + 1];
      if (next !== undefined && next !== "\n") {
        add(next);
        marked = true;
      }
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const end = close < 0 ? src.length : close;
      add(src.slice(i + 1, end));
      marked = true;
      i = end + 1;
    } else if (c === '"') {
      add("");
      marked = true;
      i += 1;
      while (i < src.length && src[i] !== '"') {
        const e = src[i] ?? "";
        const next = src[i + 1];
        if (e === "\\") {
          if (next !== undefined && next !== "\n") {
            add(next);
          }
          i += 2;
        } else if (e === "$" && next === "(") {
          const end = closingParen(src, i + 2);
          nested.push(...shellCommands(src.slice(i + 2, end), depth + 1));
          add(SUBSTITUTION);
          i = end + 1;
        } else if (e === "`") {
          const end = closingBacktick(src, i + 1);
          nested.push(...shellCommands(src.slice(i + 1, end), depth + 1));
          add(SUBSTITUTION);
          i = end + 1;
        } else {
          add(e);
          i += 1;
        }
      }
      i += 1;
    } else if (c === "$" && src[i + 1] === "'") {
      const decoded = ansiC(src, i + 2);
      add(decoded.value);
      marked = true;
      i = decoded.end;
    } else if (c === "$" && src[i + 1] === '"') {
      i += 1;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = closingParen(src, i + 2);
      nested.push(...shellCommands(src.slice(i + 2, end), depth + 1));
      add(SUBSTITUTION);
      i = end + 1;
    } else if (c === "`") {
      const end = closingBacktick(src, i + 1);
      nested.push(...shellCommands(src.slice(i + 1, end), depth + 1));
      add(SUBSTITUTION);
      i = end + 1;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
      i += 1;
    } else if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      endWord();
      i += 1;
    } else if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") {
        i += 1;
      }
    } else {
      add(c);
      i += 1;
    }
  }
  endCommand();
  return [...commands, ...nested];
}

/**
 * The commands of an exec-form list of words.
 * @param {string[]} execWords
 * @param {number} depth
 * @returns {string[][]}
 */
function execCommands(execWords, depth) {
  /** @type {string[][]} */
  const nested = [];
  for (const word of execWords) {
    if (NEEDS_READING_AGAIN.test(word)) {
      nested.push(...shellCommands(word, depth + 1));
    }
  }
  return [execWords, ...nested];
}

/** @param {string} word */
function baseName(word) {
  return word.slice(word.lastIndexOf("/") + 1).toLowerCase().replace(/\.exe$/, "");
}

/** @param {string[]} words */
function quoteCommand(words) {
  return show(words.join(" "));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that run the next command; a command name after them is the one that runs.
// The number is how many plain arguments the word takes first (timeout 60, chrt 10,
// taskset 0x1, flock file, retry 3).
const PREFIX_WORDS = new Map(
  "command sudo doas env exec xargs nice ionice time nohup setsid stdbuf watch builtin eval ! if then else elif do while until { }".split(" ").map((word) => [word, 0]),
);
for (const word of ["timeout", "chrt", "taskset", "flock", "retry"]) {
  PREFIX_WORDS.set(word, 1);
}

/** @param {string} word */
const isDynamic = (word) => DYNAMIC_WORD.test(word);

/**
 * The index of the word that is the name of the command that runs, when its text
 * is unknown: a substitution or a parameter (`$(which docker) push`, `$PNPM
 * install`). Assignments and the prefix words (command, sudo, env, timeout, xargs,
 * nice, ...) with their options and plain arguments are skipped. Used for the
 * commands read again from a quoted string, where any dynamic word may be prose.
 * @param {string[]} words
 * @returns {number[]}
 */
function dynamicCommandNames(words) {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) {
    i += 1;
  }
  const first = words[i];
  if (first === undefined) {
    return [];
  }
  if (isDynamic(first)) {
    return [i];
  }
  let pending = PREFIX_WORDS.get(baseName(first));
  if (pending === undefined) {
    return [];
  }
  let afterOption = false;
  for (let j = i + 1; j < words.length; j += 1) {
    const word = words[j] ?? "";
    if (ASSIGNMENT.test(word)) {
      continue;
    }
    if (isDynamic(word)) {
      return [j];
    }
    if (word.startsWith("-")) {
      afterOption = true;
    } else if (afterOption) {
      afterOption = false;
    } else if (pending > 0) {
      pending -= 1;
    } else {
      pending = PREFIX_WORDS.get(baseName(word));
      if (pending === undefined) {
        return [];
      }
    }
  }
  return [];
}

/**
 * The image-push findings of one command.
 * @param {string[]} words
 * @returns {string[]}
 */
function pushMessages(words) {
  /** @type {string[]} */
  const messages = [];
  const toolAt = Math.min(
    ...[words.findIndex((word) => CONTAINER_TOOLS.has(baseName(word))), words.findIndex((word) => isDynamic(word) && !ASSIGNMENT.test(word))].filter((index) => index >= 0),
    words.length,
  );
  if (toolAt < words.length && words.slice(toolAt + 1).some((word) => word.toLowerCase() === "push")) {
    messages.push(`${String(words[toolAt])} (a container tool, or a command name this check cannot read) ... push pushes an image: ${quoteCommand(words)}`);
  }
  words.forEach((word, index) => {
    const name = baseName(word);
    const lowerWord = word.toLowerCase();
    if (REGISTRY_TOOLS.has(name)) {
      messages.push(`${name} writes to a registry: ${quoteCommand(words)}`);
    }
    if (/^--push(=(?!false$).*)?$/i.test(word)) {
      messages.push(`${word} pushes an image: ${quoteCommand(words)}`);
    }
    if (/(^|[^A-Za-z0-9_-])push=(?!false(?![A-Za-z0-9_])|0(?![A-Za-z0-9_]))/i.test(word)) {
      messages.push(`an output with push= pushes an image: ${quoteCommand(words)}`);
    }
    if (/(^|[^A-Za-z0-9_-])type=registry(?![A-Za-z0-9_-])/i.test(word)) {
      messages.push(`an output of type registry pushes an image: ${quoteCommand(words)}`);
    }
    if (lowerWord === "imagetools") {
      messages.push(`imagetools writes to a registry: ${quoteCommand(words)}`);
    }
    if ((words[index - 1] === "-o" || words[index - 1] === "--output") && /^registry(,|$)/i.test(word)) {
      messages.push(`an output of type registry pushes an image: ${quoteCommand(words)}`);
    }
  });
  return messages;
}

// An image named by a digest: a name, an optional tag, and @sha256: with 64 lower-case
// hex digits. A name or digest built from a parameter, a substitution or an expression
// cannot be read, so it does not count.
const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** @param {string} image */
const isPinnedImage = (image) => !isDynamic(image) && PINNED_IMAGE.test(image);

/** @param {string} word */
const isBuildx = (word) => ["buildx", "docker-buildx"].includes(baseName(word));

/**
 * The values of a long option given as `--name value` or `--name=value`.
 * @param {string[]} words
 * @param {string} name
 */
function optionValues(words, name) {
  /** @type {string[]} */
  const values = [];
  words.forEach((word, index) => {
    if (word === name) {
      values.push(words[index + 1] ?? "");
    } else if (word.startsWith(`${name}=`)) {
      values.push(word.slice(name.length + 1));
    }
  });
  return values;
}

/**
 * The `key=` entries of comma- or line-separated build options, with the key removed.
 * @param {string[]} values
 * @param {string} key
 * @param {RegExp} separator
 */
function entriesOf(values, key, separator) {
  const prefix = `${key}=`;
  return values.flatMap((value) => value.split(separator)).filter((entry) => entry.slice(0, prefix.length).toLowerCase() === prefix).map((entry) => entry.slice(prefix.length));
}

/**
 * The findings about the image of a builder or of an SBOM generator.
 * @param {string[]} images The values named, none when the image is not named.
 * @param {string} what
 * @param {string} option
 * @param {string[]} words
 */
function pinnedImageMessages(images, what, option, words) {
  if (images.length === 0) {
    return [`${what} is not named (${option}=<name>@sha256:<digest>), so it comes from a floating upstream tag: ${quoteCommand(words)}`];
  }
  return images.filter((image) => !isPinnedImage(image)).map((image) => `${what} ${show(image)} is not pinned by a sha256 digest: ${quoteCommand(words)}`);
}

/**
 * The findings of one command about the images that build: the builder
 * `docker buildx create` starts and the generator of a requested SBOM.
 * @param {string[]} words
 * @returns {string[]}
 */
function buildImageMessages(words) {
  /** @type {string[]} */
  const messages = [];
  const buildxAt = words.findIndex(isBuildx);
  if (buildxAt >= 0) {
    let at = buildxAt + 1;
    while (at < words.length && (words[at] ?? "").startsWith("-")) {
      at += words[at] === "--builder" ? 2 : 1;
    }
    const sub = words[at];
    if (sub !== undefined && isDynamic(sub)) {
      messages.push(`a buildx subcommand this check cannot read may be create, which starts a builder: ${quoteCommand(words)}`);
    } else if (sub?.toLowerCase() === "create") {
      messages.push(...pinnedImageMessages(entriesOf(optionValues(words, "--driver-opt"), "image", /,/), "the image of the builder buildx create starts", "--driver-opt image", words));
    }
  }
  if (buildxAt >= 0 || words.some((word) => CONTAINER_TOOLS.has(baseName(word)))) {
    /** @type {string[]} */
    const requests = [];
    words.forEach((word, index) => {
      if (word === "--sbom" || word.startsWith("--sbom=")) {
        const value = word === "--sbom" ? words[index + 1] : word.slice("--sbom=".length);
        if (value?.toLowerCase() !== "false") {
          requests.push(value === undefined || value.startsWith("-") ? "true" : value);
        }
      }
    });
    for (const attestation of optionValues(words, "--attest")) {
      if (attestation.split(",").some((entry) => entry.toLowerCase() === "type=sbom")) {
        requests.push(attestation);
      }
    }
    for (const request of requests) {
      messages.push(...pinnedImageMessages(entriesOf([request], "generator", /,/), "the generator of the SBOM", "generator", words));
    }
  }
  return messages;
}

/**
 * True when the check reads a file of this name as a Dockerfile.
 * @param {string} path
 */
function isDockerfilePath(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return !isDynamic(path) && DOCKERFILE_NAME.test(name) && !SOURCE_SUFFIX.test(name);
}

/**
 * The findings about the file a build command builds from: it must be named like a
 * Dockerfile, the names the check lists and reads.
 * @param {string[]} words
 * @returns {string[]}
 */
function buildFileMessages(words) {
  const toolAt = words.findIndex((word) => CONTAINER_TOOLS.has(baseName(word)) || isBuildx(word));
  if (toolAt < 0 || words.some((word) => ["compose", "docker-compose"].includes(baseName(word)))) {
    return [];
  }
  if (!words.slice(toolAt + 1).some((word) => word === "build" || word === "bud")) {
    return [];
  }
  /** @type {string[]} */
  const messages = [];
  words.forEach((word, index) => {
    /** @type {string | undefined} */
    let file;
    if (word === "-f" || word === "--file") {
      file = words[index + 1] ?? "";
    } else if (word.startsWith("--file=")) {
      file = word.slice("--file=".length);
    } else if (word.startsWith("-f") && !word.startsWith("--") && word.length > 2) {
      file = word.slice(2).replace(/^=/, "");
    }
    if (file !== undefined && !isDockerfilePath(file)) {
      messages.push(`the build file ${show(file)} is not named like a Dockerfile (Dockerfile, Containerfile or *.Dockerfile), so it is not read: ${quoteCommand(words)}`);
    }
  });
  return messages;
}

const UNKNOWN_SUBCOMMAND = "<unknown>";

/**
 * The subcommand of a package manager command: one of the given ones, the
 * placeholder UNKNOWN_SUBCOMMAND when it cannot be told (a word built from a
 * substitution or a parameter, or an option of unknown kind before a command that
 * is none of the given ones), or undefined when it is another command. Options are
 * skipped, with the value of an option known to take one; the prefixes (pnpm's
 * recursive, multi and m) are skipped too. The word after an option of unknown kind
 * is read as its value and as the subcommand, so `npm --foo test install` is an
 * install. Any other word is the command, and what follows is its own.
 * @param {string[]} words
 * @param {number} from
 * @param {(word: string) => boolean} isSubcommand
 * @param {Set<string>} valueOptions
 * @param {Set<string>} flags
 * @param {Set<string>} prefixes
 */
function subcommand(words, from, isSubcommand, valueOptions, flags, prefixes) {
  let ambiguous = false;
  let unknownOption = false;
  for (let i = from; i < words.length; i += 1) {
    const word = words[i] ?? "";
    if (word.startsWith("-")) {
      if (word.includes("=")) {
        ambiguous = false;
      } else if (valueOptions.has(word)) {
        i += 1;
        ambiguous = false;
      } else if (flags.has(word) || (word.startsWith("--no-") && flags.has(`--${word.slice(5)}`))) {
        // A flag takes a following true or false (nothing else) as its value (`--frozen-lockfile false install`).
        ambiguous = false;
        if (/^(true|false)$/i.test(words[i + 1] ?? "")) {
          i += 1;
        }
      } else {
        ambiguous = true;
        unknownOption = true;
      }
    } else if (isDynamic(word)) {
      return UNKNOWN_SUBCOMMAND;
    } else if (prefixes.has(word)) {
      ambiguous = false;
    } else if (isSubcommand(word)) {
      return word;
    } else if (ambiguous) {
      ambiguous = false;
    } else {
      return unknownOption ? UNKNOWN_SUBCOMMAND : undefined;
    }
  }
  return unknownOption ? UNKNOWN_SUBCOMMAND : undefined;
}

/**
 * True when the word after `words[index]` is a value that turns the flag off: a
 * false-like word, or a substitution, parameter or expression (which might be one).
 * @param {string[]} words
 * @param {number} index
 */
function followedByOff(words, index) {
  const next = words[index + 1];
  return next !== undefined && (/^(false|0|no|off)$/i.test(next) || isDynamic(next));
}

const NPM_GLOBAL_INSTALL = new Set("install i in ins inst insta instal isnt isnta isntal isntall add".split(" "));
const EXACT_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;
// The only options the exemption accepts. npm expands abbreviations (--loc is
// --local, -reg is --registry) and shorthands (--local is --no-global), so any
// other word that starts with a dash makes the install not exempt.
const NPM_GLOBAL_SPELLINGS = new Set(["-g", "--global", "--global=true", "--location=global"]);
const NPM_EXEMPT_OPTIONS = new Set(["--ignore-scripts"]);

/**
 * True for the one npm install that is exempt from the lockfile rule: a global
 * install of packages at an exact version. An allow-list: the subcommand is
 * install, add, i, in, ins, inst, insta, instal, isnt, isnta, isntal or isntall (never
 * ci or update); the only options are one of the global
 * spellings -g, --global, --global=true, --location=global (or --location and
 * global as two words) and --ignore-scripts, anywhere in the command, so a short
 * cluster such as -gf, a flag value such as `-g true`, --local, --no-global, any
 * other option and any dynamic word make it not exempt; at least one global
 * spelling is present; and every package, including those after `--`, is
 * name@x.y.z with an optional pre-release or +build and an optional scope.
 * @param {string[]} words The words of the command.
 * @param {number} npmAt The index of the npm word.
 */
function isExactGlobalNpmInstall(words, npmAt) {
  const args = words.slice(npmAt + 1);
  const dashes = args.indexOf("--");
  const options = dashes >= 0 ? args.slice(0, dashes) : args;
  /** @type {string[]} */
  const packages = dashes >= 0 ? args.slice(dashes + 1) : [];
  let global = false;
  let subcommandSeen = false;
  for (let i = 0; i < options.length; i += 1) {
    const word = options[i] ?? "";
    if (!word.startsWith("-")) {
      if (!subcommandSeen) {
        if (!NPM_GLOBAL_INSTALL.has(word)) {
          return false;
        }
        subcommandSeen = true;
      } else {
        packages.push(word);
      }
    } else if (NPM_GLOBAL_SPELLINGS.has(word)) {
      global = true;
    } else if (word === "--location" && options[i + 1] === "global") {
      global = true;
      i += 1;
    } else if (!NPM_EXEMPT_OPTIONS.has(word)) {
      return false;
    }
  }
  return global && subcommandSeen && packages.length > 0 && packages.every((name) => EXACT_PACKAGE.test(name));
}

/**
 * True when `words[index]` is a versioned package (`pnpm@10.34.6`) named as an
 * argument of an npm install before it, not a pnpm that runs (`npx pnpm@10 install`).
 * @param {string[]} words
 * @param {number} index
 */
function isNpmInstallArgument(words, index) {
  if (!(words[index] ?? "").includes("@")) {
    return false;
  }
  for (let npmAt = 0; npmAt < index; npmAt += 1) {
    if (baseName(words[npmAt] ?? "") === "npm") {
      const sub = subcommand(words.slice(0, index), npmAt + 1, isNpmInstallOrModifyWord, NPM_VALUE_OPTIONS, NPM_FLAGS, new Set());
      if (sub !== undefined && sub !== UNKNOWN_SUBCOMMAND) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string[]} words
 * @returns {string[]}
 */
function installMessages(words) {
  /** @type {string[]} */
  const messages = [];
  const negative = words.some(
    (word, index) =>
      /^--no-frozen-lockfile/i.test(word) ||
      /frozen-lockfile=(false|0|no|off)$/i.test(word) ||
      (/^--frozen-lockfile=?$/i.test(word) && followedByOff(words, index)),
  );
  const positive = words.some((word) => /^--frozen-lockfile(=(true|1|yes))?$/i.test(word));
  const unfrozen = !positive || negative;
  const pnpmCommands = new Set([...PNPM_INSTALL, ...PNPM_MODIFY]);
  // A dynamic word (a substitution, a parameter or an expression; an assignment is
  // not one) before a literal package manager, or where there is none, may hide pnpm
  // or npm behind any prefix word (`timeout 60 $PNPM install`). The options of such a
  // command are not parsed, since the two tools read them differently: any later
  // word that installs or modifies for either tool fails, and --frozen-lockfile earns
  // no credit. In a command read again from a quoted string (which may be prose) only
  // a dynamic command name behind the known prefix words counts. The `in` of a case
  // or for statement is not a command.
  const firstManager = words.findIndex((word) => /^(pnpm(@[^/]*)?(\.c?js|\.mjs|\.cmd)?|npm(@[^/]*)?|yarn|yarnpkg)$/.test(baseName(word)));
  const dynamicAt = RESCANNED.has(words) ? (dynamicCommandNames(words)[0] ?? -1) : words.findIndex((word) => isDynamic(word) && !ASSIGNMENT.test(word));
  if (dynamicAt >= 0 && (firstManager < 0 || dynamicAt < firstManager)) {
    const shellSyntax = ["case", "for", "select"].includes(words[0] ?? "");
    const later = words.slice(dynamicAt + 1).find((word) => isInstallOrModifyWord(word) && !(shellSyntax && word === "in"));
    if (later !== undefined) {
      messages.push(`a word this check cannot read, then ${later}, may be pnpm or npm changing the lockfile or the installed packages: ${quoteCommand(words)}`);
    }
  }
  words.forEach((word, index) => {
    const name = baseName(word);
    if (/^pnpm(@[^/]*)?(\.c?js|\.mjs|\.cmd)?$/.test(name) && !isNpmInstallArgument(words, index)) {
      const sub = subcommand(words, index + 1, (w) => pnpmCommands.has(w), PNPM_VALUE_OPTIONS, PNPM_FLAGS, PNPM_PREFIXES);
      if (sub !== undefined && PNPM_MODIFY.has(sub)) {
        messages.push(`pnpm ${sub} changes the lockfile or the installed packages: ${quoteCommand(words)}`);
      } else if (sub !== undefined && (PNPM_INSTALL.has(sub) || sub === UNKNOWN_SUBCOMMAND) && unfrozen) {
        messages.push(`pnpm ${sub} without --frozen-lockfile (or with it turned off): ${quoteCommand(words)}`);
      } else if (sub !== undefined && PNPM_INSTALL.has(sub) && words.some((w) => /^--(fix-lockfile|lockfile-only|no-lockfile|lockfile=false)$/.test(w))) {
        messages.push(`pnpm ${sub} may change the lockfile: ${quoteCommand(words)}`);
      }
    } else if (name === "npm" || /^npm@[^/]*$/.test(name)) {
      const sub = subcommand(words, index + 1, isNpmInstallOrModifyWord, NPM_VALUE_OPTIONS, NPM_FLAGS, new Set());
      if (sub !== undefined && !isExactGlobalNpmInstall(words, index)) {
        messages.push(`npm ${sub} outside a global install of exact versions: ${quoteCommand(words)}`);
      }
    } else if (YARN_TOOLS.has(name)) {
      messages.push(`yarn is not used by this repository: ${quoteCommand(words)}`);
    }
    if (/frozen_lockfile/i.test(word)) {
      messages.push(`a frozen-lockfile setting through the environment: ${quoteCommand(words)}`);
    }
    if (/(^|[^A-Za-z0-9-])(--)?no-frozen-lockfile/i.test(word) || /frozen-lockfile\s*=\s*(false|0|no|off)$/i.test(word)) {
      messages.push(`the frozen lockfile turned off: ${quoteCommand(words)}`);
    }
  });
  return messages;
}

/**
 * @param {string[][]} commands
 * @param {boolean} allowPush
 * @returns {{ rule: string, message: string }[]}
 */
function scanCommands(commands, allowPush) {
  /** @type {Map<string, { rule: string, message: string }>} */
  const found = new Map();
  for (const words of commands) {
    for (const message of installMessages(words)) {
      found.set(`frozen-lockfile ${message}`, { rule: "frozen-lockfile", message });
    }
    for (const message of buildImageMessages(words)) {
      found.set(`pinned-build-images ${message}`, { rule: "pinned-build-images", message });
    }
    for (const message of buildFileMessages(words)) {
      found.set(`dockerfile ${message}`, { rule: "dockerfile", message });
    }
    if (!allowPush) {
      for (const message of pushMessages(words)) {
        found.set(`image-push ${message}`, { rule: "image-push", message });
      }
    }
  }
  return [...found.values()];
}

/**
 * @param {string} text
 * @param {boolean} allowPush
 */
function scanShellText(text, allowPush) {
  return scanCommands(shellCommands(withoutExpressions(text)), allowPush);
}

// ---- Workflows and actions --------------------------------------------------------

/**
 * @param {unknown} value
 * @param {boolean} isRelease
 * @param {Report} report
 */
function checkPermissions(value, isRelease, report) {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    const level = value.toLowerCase();
    if (level === "write-all") {
      report("image-push", "permissions: write-all grants packages: write");
    } else if (level !== "read-all") {
      report("image-push", `permissions: ${show(value)} is not a form this check reads`);
    }
    return;
  }
  if (!isMap(value)) {
    report("image-push", `permissions: ${show(value)} is not a form this check reads`);
    return;
  }
  for (const [key, level] of value) {
    if (lower(key) !== "packages" || isRelease) {
      continue;
    }
    const text = typeof level === "string" ? level.toLowerCase() : "";
    if (text !== "read" && text !== "none") {
      report("image-push", `packages: ${show(level)} outside ${RELEASE_WORKFLOW}`);
    }
  }
}

/**
 * What a build action is given: the builder image (driver-opts of
 * docker/setup-buildx-action), the SBOM generator (the sbom and attests inputs) and
 * the file to build from (the file input of docker/build-push-action).
 * @param {Map<string, unknown>} step
 * @param {string} uses
 * @param {Report} report
 */
function checkBuildInputs(step, uses, report) {
  const inputs = get(step, "with");
  const action = (uses.split("@")[0] ?? "").toLowerCase();
  /** @param {string} name */
  const text = (name) => {
    const value = get(inputs, name);
    return value === undefined || value === null ? undefined : String(value);
  };
  /** @param {string[]} messages */
  const reportAll = (messages) => {
    for (const message of messages) {
      report("pinned-build-images", message);
    }
  };
  if (action === "docker/setup-buildx-action") {
    reportAll(pinnedImageMessages(entriesOf([text("driver-opts") ?? ""], "image", /[\n,]/), `the builder image of ${show(uses)}`, "driver-opts: image", [uses]));
  }
  const file = text("file");
  if (action === "docker/build-push-action" && file !== undefined && !isDockerfilePath(file)) {
    report("dockerfile", `the build file ${show(file)} of ${show(uses)} is not named like a Dockerfile (Dockerfile, Containerfile or *.Dockerfile), so it is not read`);
  }
  const sbom = text("sbom");
  if (sbom !== undefined && sbom.toLowerCase() !== "false") {
    reportAll(pinnedImageMessages(entriesOf([sbom], "generator", /,/), `the SBOM generator of ${show(uses)}`, "sbom: generator", [uses]));
  }
  for (const attestation of (text("attests") ?? "").split("\n")) {
    if (attestation.split(",").some((entry) => entry.trim().toLowerCase() === "type=sbom")) {
      reportAll(pinnedImageMessages(entriesOf([attestation], "generator", /,/), `the SBOM generator of ${show(uses)}`, "attests: generator", [uses]));
    }
  }
}

/**
 * @param {Map<string, unknown>} step
 * @param {boolean} isRelease
 * @param {Report} report
 */
function checkUses(step, isRelease, report) {
  const uses = get(step, "uses");
  if (typeof uses !== "string") {
    report("image-push", `uses: ${show(uses)} is not a form this check reads`);
    return;
  }
  checkBuildInputs(step, uses, report);
  if (isRelease) {
    return;
  }
  const action = (uses.split("@")[0] ?? "").toLowerCase();
  if (action.split(/[^a-z0-9]+/).includes("push")) {
    report("image-push", `uses: ${show(uses)} is an action that pushes`);
  }
  const inputs = get(step, "with");
  if (!isMap(inputs)) {
    return;
  }
  for (const [name, input] of inputs) {
    if (lower(name) === "push" && !(input === false || (typeof input === "string" && input.toLowerCase() === "false"))) {
      report("image-push", `${show(uses)} with push: ${show(input)}`);
    }
    if (typeof input === "string" && /(^|[^A-Za-z0-9_-])(push=(?!false(?![A-Za-z0-9_])|0(?![A-Za-z0-9_]))|type=registry)/i.test(input)) {
      report("image-push", `${show(uses)} with ${name}: ${show(input)} pushes an image`);
    }
  }
}

/**
 * The rules every workflow and action file is held to.
 * @param {unknown} root
 * @param {boolean} isRelease
 * @param {Report} report
 */
function checkCommon(root, isRelease, report) {
  walk(
    root,
    (map) => {
      for (const [key, value] of map) {
        const name = lower(key);
        if (name === "permissions") {
          checkPermissions(value, isRelease, report);
        }
        if (name === "run" && typeof value === "string") {
          for (const found of scanShellText(value, isRelease)) {
            report(found.rule, found.message);
          }
        } else if (name === "run" && Array.isArray(value)) {
          report("image-push", `run: ${show(value)} is not a form this check reads`);
        }
        if (/frozen_lockfile/i.test(String(key))) {
          report("frozen-lockfile", `the setting ${String(key)} configures the frozen lockfile through the environment`);
        }
      }
      if (has(map, "uses")) {
        checkUses(map, isRelease, report);
      }
    },
    () => undefined,
  );
}

/**
 * The local paths a workflow or action `uses`: values that start with ./ or ../.
 * @param {unknown} root
 * @returns {string[]}
 */
function localUses(root) {
  /** @type {string[]} */
  const paths = [];
  walk(
    root,
    (map) => {
      for (const [key, value] of map) {
        if (lower(key) === "uses" && typeof value === "string" && /^\.{1,2}(\/|$)/.test(value)) {
          paths.push(value);
        }
      }
    },
    () => undefined,
  );
  return paths;
}

/**
 * The trigger names of an `on` value, or undefined when the form is not one GitHub documents.
 * @param {unknown} on
 * @returns {string[] | undefined}
 */
function triggerNames(on) {
  if (typeof on === "string") {
    return [on.toLowerCase()];
  }
  if (Array.isArray(on) && on.every((item) => typeof item === "string")) {
    return on.map((item) => String(item).toLowerCase());
  }
  if (isMap(on)) {
    return [...on.keys()].map((key) => key.toLowerCase());
  }
  return undefined;
}

/**
 * @param {unknown} root
 * @param {Report} report
 */
function checkPullRequestSecrets(root, report) {
  walk(
    root,
    (map) => {
      for (const [key, value] of map) {
        if (lower(key) === "secrets" && typeof value === "string" && value.toLowerCase() === "inherit") {
          report("pull-request-secrets", "secrets: inherit hands every secret to a workflow a pull request can start");
        }
      }
    },
    (text, key) => {
      if ((text.includes("${{") || key === "if") && readsOtherSecret(text)) {
        report("pull-request-secrets", `reads a secret other than secrets.GITHUB_TOKEN: ${show(text)}`);
      }
    },
  );
  const jobs = get(root, "jobs");
  if (!isMap(jobs)) {
    report("pull-request-secrets", "the jobs are not a mapping, so the environments cannot be read");
    return;
  }
  for (const [id, job] of jobs) {
    if (!isMap(job)) {
      report("pull-request-secrets", `job ${id} is not a mapping, so its environment cannot be read`);
    } else if (has(job, "environment")) {
      report("pull-request-secrets", `job ${id} names an environment`);
    }
  }
}

/**
 * A workflow without a permissions block gets the repository's default token
 * permissions, which may include packages: write. It declares them at its top level
 * or on every job.
 * @param {unknown} root
 * @param {Report} report
 */
function checkPermissionsDeclared(root, report) {
  /** @param {unknown} map */
  const declares = (map) => {
    const value = get(map, "permissions");
    return value !== undefined && value !== null;
  };
  if (declares(root)) {
    return;
  }
  const jobs = get(root, "jobs");
  if (isMap(jobs) && jobs.size > 0 && [...jobs.values()].every(declares)) {
    return;
  }
  report("permissions-declared", "neither the workflow nor every one of its jobs declares permissions, so the default token permissions apply");
}

/**
 * @param {unknown} on
 * @param {Report} report
 */
function checkReleaseTriggers(on, report) {
  if (!isMap(on) || on.size === 0) {
    report("release-triggers", `on: ${show(on)} is not a push to main and a published release`);
    return;
  }
  /** @param {unknown} value @param {string} expected */
  const only = (value, expected) => Array.isArray(value) && value.length === 1 && value[0] === expected;
  for (const [key, value] of on) {
    const name = lower(key);
    if (name === "push") {
      if (!isMap(value) || value.size !== 1 || !only(get(value, "branches"), "main")) {
        report("release-triggers", `push must have exactly branches: [main], not ${show(value)}`);
      }
    } else if (name === "release") {
      if (!isMap(value) || value.size !== 1 || !only(get(value, "types"), "published")) {
        report("release-triggers", `release must have exactly types: [published], not ${show(value)}`);
      }
    } else {
      report("release-triggers", `the trigger ${key} is neither a push to main nor a published release`);
    }
  }
}

/**
 * @param {string} file
 * @param {unknown} root
 * @param {"workflow" | "action"} kind
 * @param {Report} report
 */
function checkWorkflowOrAction(file, root, kind, report) {
  if (!isMap(root)) {
    report("yaml", `the ${kind} is not a mapping`);
    return;
  }
  const isRelease = file === RELEASE_WORKFLOW;
  checkCommon(root, isRelease, report);
  if (kind !== "workflow") {
    return;
  }
  checkPermissionsDeclared(root, report);
  const on = get(root, "on");
  if (isRelease) {
    checkReleaseTriggers(on, report);
  }
  const names = triggerNames(on);
  if (names === undefined) {
    report("pull-request-secrets", `the trigger (on: ${show(on)}) is not a form this check reads`);
  } else if (names.some((name) => STARTABLE_EVENT.test(name))) {
    checkPullRequestSecrets(root, report);
  }
}

// ---- Dockerfiles --------------------------------------------------------------------

const KNOWN_INSTRUCTIONS = new Set("FROM RUN CMD ENTRYPOINT HEALTHCHECK ONBUILD SHELL ENV ARG LABEL WORKDIR COPY ADD EXPOSE VOLUME USER STOPSIGNAL MAINTAINER".split(" "));
// Each flag owns the whitespace after it, so no input splits into flags in more than one way.
const SHELL_FORM_FLAG = /^\s*(?:--[A-Za-z][A-Za-z-]*(?:=\S*)?\s+)+/;

/**
 * @param {string} text
 * @returns {{ keyword: string, args: string, bodies: string[], line: number }[]}
 */
function parseDockerfile(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let escape = "\\";
  let at = 0;
  while (at < lines.length) {
    const directive = /^\s*#\s*(syntax|escape|check)\s*=\s*(.*?)\s*$/i.exec(lines[at] ?? "");
    if (directive === null) {
      break;
    }
    if ((directive[1] ?? "").toLowerCase() === "escape") {
      if (directive[2] !== "\\" && directive[2] !== "`") {
        throw new PolicyError("dockerfile", `the escape directive ${show(directive[2])} is not \\ or a backtick`);
      }
      escape = directive[2];
    }
    at += 1;
  }
  /** @type {{ keyword: string, args: string, bodies: string[], line: number }[]} */
  const instructions = [];
  while (at < lines.length) {
    const first = lines[at] ?? "";
    if (first.trim() === "" || first.trim().startsWith("#")) {
      at += 1;
      continue;
    }
    const line = at + 1;
    let joined = "";
    let continuing = false;
    while (at < lines.length) {
      const raw = lines[at] ?? "";
      at += 1;
      if (continuing && (raw.trim() === "" || raw.trim().startsWith("#"))) {
        continue;
      }
      const trimmed = raw.replace(/\s+$/, "");
      if (trimmed.endsWith(escape)) {
        joined += trimmed.slice(0, -1);
        continuing = true;
      } else {
        joined += raw;
        break;
      }
    }
    const parsed = /^\s*([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(joined);
    if (parsed === null) {
      throw new PolicyError("dockerfile", `line ${String(line)}: cannot classify the instruction ${show(joined)}`);
    }
    const keyword = (parsed[1] ?? "").toUpperCase();
    const args = parsed[2] ?? "";
    /** @type {string[]} */
    const bodies = [];
    if (keyword === "RUN" || keyword === "COPY" || keyword === "ADD") {
      for (const word of args.split(/\s+/)) {
        const marker = /^\d*<<(-?)(.+)$/.exec(word);
        if (marker === null) {
          continue;
        }
        const strip = marker[1] === "-";
        const delimiter = (marker[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
        const body = [];
        let closed = false;
        while (at < lines.length) {
          const raw = lines[at] ?? "";
          at += 1;
          if ((strip ? raw.replace(/^\t+/, "") : raw) === delimiter) {
            closed = true;
            break;
          }
          body.push(raw);
        }
        if (!closed) {
          throw new PolicyError("dockerfile", `line ${String(line)}: the heredoc ${delimiter} is never closed`);
        }
        bodies.push(body.join("\n"));
      }
    }
    instructions.push({ keyword, args, bodies, line });
  }
  return instructions;
}

/**
 * The commands a RUN, CMD or ENTRYPOINT runs.
 * @param {string} args
 * @param {string[]} bodies
 * @param {boolean} stripFlags
 * @returns {string[][]}
 */
function instructionCommands(args, bodies, stripFlags) {
  let rest = stripFlags ? args.replace(SHELL_FORM_FLAG, "") : args;
  rest = rest.trim();
  if (rest.startsWith("[")) {
    /** @type {unknown} */
    let list;
    try {
      list = JSON.parse(rest);
    } catch {
      list = undefined;
    }
    if (Array.isArray(list) && list.every((item) => typeof item === "string")) {
      return execCommands(/** @type {string[]} */ (list), 0);
    }
  }
  return shellCommands([rest, ...bodies].join("\n"));
}

/**
 * @param {string} text
 * @param {Report} report
 */
function checkDockerfile(text, report) {
  /** @param {{ keyword: string, args: string, bodies: string[], line: number }} instruction */
  const check = (instruction) => {
    const { keyword, args, bodies, line } = instruction;
    if (!KNOWN_INSTRUCTIONS.has(keyword)) {
      throw new PolicyError("dockerfile", `line ${String(line)}: cannot classify the instruction ${keyword}`);
    }
    if (keyword === "ENV" || keyword === "ARG") {
      if (/frozen_lockfile/i.test(args)) {
        report("frozen-lockfile", `line ${String(line)}: a frozen-lockfile setting through the environment: ${show(args)}`);
      }
    } else if (keyword === "ONBUILD") {
      const inner = /^\s*([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(args);
      check({ keyword: (inner?.[1] ?? "").toUpperCase(), args: inner?.[2] ?? "", bodies, line });
    } else if (keyword === "SHELL") {
      /** @type {unknown} */
      let list;
      try {
        list = JSON.parse(args);
      } catch {
        list = undefined;
      }
      const posix = Array.isArray(list) && list.length > 0 && list.every((item) => typeof item === "string") && /^(ba|da|a|z|k)?sh$/.test(baseName(String(list[0]))) && list.slice(1).every((item) => /^(-[A-Za-z]+|pipefail|errexit|nounset)$/.test(String(item)));
      if (!posix) {
        throw new PolicyError("dockerfile", `line ${String(line)}: the SHELL ${show(args)} is not a POSIX shell, so RUN cannot be read`);
      }
    } else if (keyword === "RUN" || keyword === "CMD" || keyword === "ENTRYPOINT" || keyword === "HEALTHCHECK") {
      let body = args;
      if (keyword === "HEALTHCHECK") {
        body = args.replace(SHELL_FORM_FLAG, "").replace(/^\s*(CMD|NONE)\b/i, "");
      }
      for (const found of scanCommands(instructionCommands(body, keyword === "RUN" ? bodies : [], keyword === "RUN"), false)) {
        report(found.rule, `line ${String(line)}: ${found.message}`);
      }
    }
  };
  for (const instruction of parseDockerfile(text)) {
    check(instruction);
  }
}

// ---- The tree -------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} relative
 * @param {(error: unknown, path: string) => void} onError
 * @param {Set<string>} skip
 * @returns {string[]}
 */
function listFiles(dir, relative, onError, skip) {
  /** @type {string[]} */
  const files = [];
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    onError(error, relative === "" ? "." : relative);
    return files;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        files.push(...listFiles(join(dir, entry.name), path, onError, skip));
      }
    } else if (entry.isSymbolicLink()) {
      try {
        if (statSync(join(dir, entry.name)).isFile()) {
          files.push(path);
        }
      } catch (error) {
        onError(error, path);
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const YAML_NAME = /\.ya?ml$/i;
const ACTION_NAME = /^action\.ya?ml$/i;
const DOCKERFILE_NAME = /^(docker|container)file(\..+)?$|\.(docker|container)file$/i;
// A name such as dockerfile.test.ts or Dockerfile.md is a Dockerfile only when it starts like one.
const SOURCE_SUFFIX = /\.(m?[jt]sx?|cjs|cts|json|md|mdx|sh|ya?ml|txt|snap|map|html|css|sql)$/i;
// Per-line whitespace excludes the newline, so a run of blank lines splits one way only.
const STARTS_LIKE_DOCKERFILE = /^(?:[^\S\n]*(?:#[^\n]*)?\n)*[^\S\n]*(?:FROM|ARG)\s/i;

/** @param {string} path @param {string} text */
function isDockerfile(path, text) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return DOCKERFILE_NAME.test(name) && (!SOURCE_SUFFIX.test(name) || STARTS_LIKE_DOCKERFILE.test(text));
}

/**
 * @param {string} root
 * @returns {{ findings: Finding[], files: number }}
 */
export function checkRepository(root) {
  /** @type {Finding[]} */
  const findings = [];
  let files = 0;
  /** @param {string} file @param {string} rule @param {string} message */
  const add = (file, rule, message) => {
    findings.push({ file, rule, message });
  };
  /** @param {string} file */
  const read = (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch (error) {
      add(file, "unreadable", error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  /** @param {unknown} error @param {string} path */
  const unreadable = (error, path) => {
    // No .github/actions folder is a tree without composite actions.
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && path === ".github/actions") {
      return;
    }
    add(path, "unreadable", error instanceof Error ? error.message : String(error));
  };
  /**
   * @param {string} file
   * @param {(text: string, report: Report) => void} check
   */
  const run = (file, check) => {
    const text = read(file);
    if (text === undefined) {
      return;
    }
    files += 1;
    try {
      check(text, (rule, message) => {
        add(file, rule, message);
      });
    } catch (error) {
      if (error instanceof PolicyError) {
        add(file, error.rule, error.message);
      } else {
        add(file, "internal", error instanceof Error ? error.message : String(error));
      }
    }
  };
  /** The workflow and action files read, so one used from several places is read once. */
  const checked = new Set();
  /** @type {{ from: string, uses: string }[]} */
  const pending = [];
  /**
   * @param {string} file
   * @param {"workflow" | "action"} kind
   */
  const checkYamlFile = (file, kind) => {
    if (checked.has(file)) {
      return;
    }
    checked.add(file);
    run(file, (text, report) => {
      const loaded = loadYaml(text);
      if (loaded.errors.length > 0) {
        for (const error of loaded.errors) {
          report("yaml", error);
        }
        return;
      }
      checkWorkflowOrAction(file, loaded.value, kind, report);
      for (const uses of localUses(loaded.value)) {
        pending.push({ from: file, uses });
      }
    });
  };
  /**
   * The action files a local `uses` names, or why it names none.
   * @param {string} uses
   * @returns {{ files: string[] } | { problem: string }}
   */
  const resolveLocalUse = (uses) => {
    if (isDynamic(uses)) {
      return { problem: `uses: ${show(uses)} holds an expression or a parameter, so the action it names cannot be read` };
    }
    const path = posix.normalize(uses).replace(/\/$/, "");
    if (path === ".." || path.startsWith("../") || path.startsWith("/")) {
      return { problem: `uses: ${show(uses)} leaves the repository` };
    }
    const dir = path === "." ? "" : path;
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(dir)) {
      return checked.has(dir) ? { files: [] } : { problem: `uses: ${show(uses)} names no workflow` };
    }
    const candidates = ["action.yml", "action.yaml"].map((name) => (dir === "" ? name : `${dir}/${name}`));
    const files = candidates.filter((candidate) => {
      try {
        return statSync(join(root, candidate)).isFile();
      } catch (error) {
        if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
          return false;
        }
        add(candidate, "unreadable", error instanceof Error ? error.message : String(error));
        return false;
      }
    });
    return files.length > 0 ? { files } : { problem: `uses: ${show(uses)} names no action: neither ${candidates.join(" nor ")} exists` };
  };

  const workflows = listFiles(join(root, ".github", "workflows"), ".github/workflows", unreadable, new Set()).filter(
    (path) => path.split("/").length === 3 && YAML_NAME.test(path),
  );
  if (workflows.length === 0 && !findings.some((finding) => finding.rule === "unreadable")) {
    add(".github/workflows", "yaml", "no workflow found, so the check would read nothing");
  }
  for (const file of workflows) {
    checkYamlFile(file, "workflow");
  }
  const actions = listFiles(join(root, ".github", "actions"), ".github/actions", unreadable, new Set()).filter((path) =>
    ACTION_NAME.test(path.slice(path.lastIndexOf("/") + 1)),
  );
  for (const file of actions) {
    checkYamlFile(file, "action");
  }
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const resolved = resolveLocalUse(next.uses);
    if ("problem" in resolved) {
      add(next.from, "local-action", resolved.problem);
    } else {
      for (const file of resolved.files) {
        checkYamlFile(file, "action");
      }
    }
  }
  const dockerfiles = listFiles(root, "", unreadable, new Set(["node_modules", ".git"])).filter((path) =>
    DOCKERFILE_NAME.test(path.slice(path.lastIndexOf("/") + 1)),
  );
  for (const file of dockerfiles) {
    run(file, (text, report) => {
      if (isDockerfile(file, text)) {
        checkDockerfile(text, report);
      }
    });
  }
  return { findings, files };
}

function main() {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  /** @type {{ findings: Finding[], files: number }} */
  let result;
  try {
    result = checkRepository(root);
  } catch (error) {
    process.stderr.write(`workflow-policy: internal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      process.stderr.write(`workflow-policy: ${finding.file}: ${finding.rule}: ${finding.message}\n`);
    }
    process.stderr.write(`workflow-policy failed: ${String(result.findings.length)} finding${result.findings.length === 1 ? "" : "s"}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`workflow-policy passed: ${String(result.files)} files follow the T16 workflow policy\n`);
  }
}

// Runs when started as a script and not when the test imports it.
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
