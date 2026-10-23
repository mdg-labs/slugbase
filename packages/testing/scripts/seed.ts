import { DEVELOPMENT_DATABASE, SeedTargetError, buildDemoInstance, createCredentials, developmentTarget, runSeedScript, seedScript } from "../src/seed/index.ts";

// `pnpm db:seed` (doc 08 section 1.3 and 1.4): fills the development database with the demo instance. It refuses
// before anything connects unless DATABASE_URL and DATABASE_MIGRATE_URL name the development database of
// compose.dev.yml. The passwords are made now, shown once below and kept nowhere else.

function fail(message: string): never {
  process.stderr.write(`db:seed: ${message}\n`);
  process.exit(1);
}

try {
  const connection = developmentTarget(process.env);
  const instance = buildDemoInstance();
  const credentials = await createCredentials(instance);
  await runSeedScript(connection, seedScript(instance, credentials.hashes), {
    path: process.env["PATH"] ?? "",
    secrets: Object.values(credentials.hashes),
  });
  const lines = [
    `db:seed: seeded ${DEVELOPMENT_DATABASE.name} with ${String(instance.workspaces.length)} workspaces and ${String(instance.workspaces.reduce((sum, workspace) => sum + workspace.bookmarks.length, 0))} bookmarks`,
    "db:seed: these passwords are shown once and work only in this database; seed an empty one again for new ones",
    ...instance.accounts.map((account) => `  ${account.email}  ${credentials.passwords[account.key]}`),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
} catch (error) {
  fail(error instanceof SeedTargetError ? `refused: ${error.message}` : error instanceof Error ? error.message : "failed");
}
