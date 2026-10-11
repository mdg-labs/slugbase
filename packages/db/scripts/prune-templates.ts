import { pruneTestTemplates } from "../src/testing.ts";

// `pnpm --filter @slugbase/db test:prune-templates` (doc 08 section 3.2): drops
// the stale `slugbase_tpl_*` templates of the test harness from the Postgres of
// SLUGBASE_TEST_PG_URL (the development Postgres by default). A template that is
// current, being built, cloned from or connected to stays. Names on the command
// line limit the prune to those templates.

try {
  const names = process.argv.slice(2);
  const { dropped, skipped } = await pruneTestTemplates(names.length === 0 ? {} : { names });
  const lines = [
    ...dropped.map((name) => `test:prune-templates: dropped ${name}`),
    ...skipped.map(({ name, reason }) => `test:prune-templates: kept ${name} (${reason})`),
    `test:prune-templates: ${String(dropped.length)} template(s) dropped, ${String(skipped.length)} kept`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  process.stderr.write(`test:prune-templates: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exit(1);
}
