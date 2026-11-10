// Tests scripts/env-docs.mjs. The checks run on the real schemas and the real template, with one
// thing changed per case: a key added to a schema, an entry of key-docs.ts dropped, a line of
// .env.example removed, the page edited. A case names the problem the check must report, and a
// final case runs the script itself on this repository. The fixtures hold placeholders only.
//
//   node scripts/env-docs.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { checkEnvironment, loadSchemaConfig, main, renderPage } from "./env-docs.mjs";

const root = resolve(import.meta.dirname, "..");
const script = join(import.meta.dirname, "env-docs.mjs");
const configDirectory = pathToFileURL(join(root, "packages", "server", "src", "config")).href;
const schemas = await import(`${configDirectory}/index.ts`);
const config = await loadSchemaConfig(root);
const template = readFileSync(join(root, "scripts", "env-docs", "environment.template.md"), "utf8");
const exampleText = readFileSync(join(root, ".env.example"), "utf8");
const pageText = readFileSync(join(root, "docs", "self-hosting", "environment.md"), "utf8");

const inputs = { template, pageText, exampleText };

/** The server schema with one more key, which reuses the field of an existing key. */
function withNewKey(key) {
  const extra = schemas.envFragment({ shape: { [key]: schemas.serverEnvSchema.object.shape.LOG_LEVEL } });
  return {
    ...config,
    envSchemas: { ...config.envSchemas, server: schemas.composeEnvSchema([...schemas.serverFragments, extra]) },
  };
}

function withDoc(key, doc) {
  return { ...config, KEY_DOCS: { ...config.KEY_DOCS, [key]: doc } };
}

function problemsOf(withConfig, changed = {}) {
  return checkEnvironment(withConfig, { ...inputs, ...changed });
}

function assertProblem(problems, text) {
  assert.ok(
    problems.some((problem) => problem.includes(text)),
    `expected a problem that includes "${text}", got:\n${problems.join("\n")}`,
  );
}

test("the page, .env.example and the schemas of this repository agree", () => {
  assert.deepEqual(problemsOf(config), []);
});

test("the page on disk is what the generator writes", () => {
  assert.equal(renderPage(config, template), pageText);
  assert.match(pageText, /^---\ntitle: "[^"\n]+"\ndescription: "[^"\n]+"\nedition: ce\n/);
});

test("the page documents the keys the item names", () => {
  for (const key of [
    "APP_ORIGIN",
    "DATABASE_URL",
    "DATABASE_MIGRATE_URL",
    "SESSION_SECRET",
    "ENCRYPTION_KEY",
    "ENCRYPTION_KEY_ID",
    "MIGRATE_ON_START",
    "PUBLIC_REGISTRATION",
    "EMAIL_VERIFICATION_REQUIRED",
    "SETUP_TOKEN_REQUIRED",
    "TRUSTED_PROXY_HOPS",
    "AUDIT_RETENTION_DAYS",
    "API_DOCS_ENABLED",
    "SMTP_HOST",
    "AI_BASE_URL",
    "OIDC_<SLUG>_CLIENT_ID",
    "ERROR_REPORT_DSN",
    "SLUGBASE_ALLOW_OWNER_CONNECTION",
  ]) {
    assert.ok(pageText.includes(`\`${key}\``), `${key} is not on the page`);
  }
});

test("a key added to a schema without a reference entry and an .env.example line is reported", () => {
  const problems = problemsOf(withNewKey("NEW_SETTING"));
  assertProblem(problems, "NEW_SETTING is declared by a process schema but has no entry in packages/server/src/config/key-docs.ts");
  assertProblem(problems, "NEW_SETTING is declared by a process schema but is not a line of .env.example");
});

test("a key added to a schema with an entry and an .env.example line, but a page not regenerated, is reported", () => {
  const added = withDoc("NEW_SETTING", { group: "runtime", type: { kind: "boolean" }, description: "A new setting." });
  const problems = checkEnvironment(
    { ...withNewKey("NEW_SETTING"), KEY_DOCS: added.KEY_DOCS },
    { ...inputs, exampleText: `${exampleText}\nNEW_SETTING=true\n` },
  );
  assert.equal(problems.length, 1, problems.join("\n"));
  assertProblem(problems, "is not what the generator writes from the schemas; run `pnpm env:docs`");
});

test("the same key, once the page is regenerated, passes", () => {
  const added = withDoc("NEW_SETTING", { group: "runtime", type: { kind: "boolean" }, description: "A new setting." });
  const next = { ...withNewKey("NEW_SETTING"), KEY_DOCS: added.KEY_DOCS };
  const problems = checkEnvironment(next, {
    template,
    pageText: renderPage(next, template),
    exampleText: `${exampleText}\nNEW_SETTING=true\n`,
  });
  assert.deepEqual(problems, []);
});

test("a key removed from a schema while its entry and line stay is reported", () => {
  const problems = problemsOf(withDoc("OLD_SETTING", { group: "runtime", type: { kind: "boolean" }, description: "Gone." }), {
    exampleText: `${exampleText}\nOLD_SETTING=true\n`,
  });
  assertProblem(problems, "OLD_SETTING has an entry in packages/server/src/config/key-docs.ts but no process schema declares it");
  assertProblem(problems, "OLD_SETTING is a line of .env.example but no process schema declares it");
});

test("a declared key that is not a line of .env.example is reported", () => {
  const problems = problemsOf(config, { exampleText: exampleText.replace(/^PORT=.*\n/m, "") });
  assertProblem(problems, "PORT is declared by a process schema but is not a line of .env.example");
});

test("an entry for a key that no schema declares is reported", () => {
  const problems = problemsOf(withDoc("GONE_KEY", { group: "runtime", type: { kind: "boolean" }, description: "Gone." }));
  assertProblem(problems, "GONE_KEY has an entry in packages/server/src/config/key-docs.ts but no process schema declares it");
});

test("a page that was edited by hand is reported", () => {
  assertProblem(problemsOf(config, { pageText: pageText.replace("The port the server listens on.", "The port.") }), "run `pnpm env:docs`");
});

test("a page that is missing is reported", () => {
  assertProblem(problemsOf(config, { pageText: "" }), "run `pnpm env:docs`");
});

test("a default that changed in the schema changes the page, so the old page is reported", () => {
  const schema = schemas.composeEnvSchema([
    ...schemas.serverFragments.filter((fragment) => !("PORT" in fragment.shape)),
    schemas.envFragment({ shape: { PORT: schemas.serverEnvSchema.object.shape.LOG_LEVEL.default("debug") } }),
  ]);
  const changed = { ...config, envSchemas: { ...config.envSchemas, server: schema } };
  assertProblem(problemsOf(changed), "run `pnpm env:docs`");
});

test("a group the template does not place is reported", () => {
  assertProblem(problemsOf(config, { template: template.replace("{{keys:mail}}", "") }), "the template has no {{keys:mail}} line");
});

test("a placeholder for a group no key belongs to is reported", () => {
  assertProblem(problemsOf(config, { template: `${template}\n{{keys:nowhere}}\n` }), "no key belongs to a group of that name");
});

test("a key the prose names that no schema declares is reported", () => {
  const changed = `${template}\nSet \`ANOTHER_SETTING\` to change it.\n`;
  assertProblem(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), "ANOTHER_SETTING is on the page but no process schema declares it");
});

test("a pattern with a placeholder in the prose is not read as a key", () => {
  const changed = `${template}\nKeys named \`RATE_LIMIT_<BUCKET>_<SCOPE>\` and \`OIDC_<SLUG>_*\`.\n`;
  assert.deepEqual(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), []);
});

test("a value given to a secret key in the prose is reported", () => {
  const changed = `${template}\nFor example \`AI_API_KEY=abc123\`.\n`;
  assertProblem(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), "the page gives a secret key a value: AI_API_KEY");
});

test("a placeholder for a secret key in the prose is accepted", () => {
  const changed = `${template}\nFor example \`AI_API_KEY=<your API key>\`.\n`;
  assert.deepEqual(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), []);
});

test("a value given to a secret key in the next cell of a table row is reported", () => {
  const changed = `${template}\n| Key | Value |\n| --- | ----- |\n| \`SESSION_SECRET\` | \`abc\` |\n`;
  assertProblem(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), "the page gives a secret key a value: SESSION_SECRET");
});

test("a placeholder for a secret key in the next cell of a table row is accepted", () => {
  const changed = `${template}\n| Key | Value |\n| --- | ----- |\n| \`SESSION_SECRET\` | \`<your secret>\` |\n`;
  assert.deepEqual(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), []);
});

test("a code span in prose after a secret key in a table row is not a value", () => {
  const changed = `${template}\n| Key | Value |\n| --- | ----- |\n| \`SESSION_SECRET\` | Set it in \`.env\`, or use \`abc\` there. |\n`;
  assert.deepEqual(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), []);
});

test("a run of characters shaped like a credential in the prose is reported", () => {
  const long = ["q", "Z", "7", "x"].join("").repeat(10);
  const changed = `${template}\nThe default is ${long}.\n`;
  assertProblem(problemsOf(config, { template: changed, pageText: renderPage(config, changed) }), "shaped like a credential");
});

test("a description that holds a value shaped like a secret is reported", () => {
  const long = ["A", "b", "C", "d"].join("").repeat(10);
  const problems = problemsOf(withDoc("LOG_LEVEL", { ...config.KEY_DOCS.LOG_LEVEL, description: `Use ${long} here.` }));
  assertProblem(problems, "the description of LOG_LEVEL holds a value that looks like a secret");
});

test("a default given to a secret key is reported", () => {
  const problems = problemsOf(withDoc("SESSION_SECRET", { ...config.KEY_DOCS.SESSION_SECRET, defaultText: "`changeme`" }));
  assertProblem(problems, "SESSION_SECRET is a secret and must have no default on the page");
});

test("the script writing the page, when the page cannot be generated, stops with status 2 and writes nothing", async () => {
  const broken = withDoc("LOG_LEVEL", { group: "runtime", description: "Has no type." });
  const written = [];
  const stderrWrite = process.stderr.write;
  const exitCode = process.exitCode;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await main([], () => Promise.resolve(broken));
    assert.equal(process.exitCode, 2);
  } finally {
    process.stderr.write = stderrWrite;
    process.exitCode = exitCode;
  }
  assert.match(written.join(""), /env-docs: could not generate the page: /);
  assert.equal(readFileSync(join(root, "docs", "self-hosting", "environment.md"), "utf8"), pageText);
});

test("the script passes on this repository", () => {
  const run = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /env-docs passed/);
});

test("the script refuses an argument it does not know", () => {
  const run = spawnSync(process.execPath, [script, "--nonsense"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown argument/);
});
