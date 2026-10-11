import { migrate } from "../src/migrate.ts";

// `pnpm db:migrate` (doc 05 section 5.3): applies the CE chain with the migrator
// credentials of DATABASE_MIGRATE_URL, exactly as the server and the image
// entrypoint will.

const url = process.env["DATABASE_MIGRATE_URL"];
if (url === undefined || url === "") {
  process.stderr.write("db:migrate: DATABASE_MIGRATE_URL is not set\n");
  process.exit(1);
}

try {
  const { applied } = await migrate({ url });
  const lines = applied.map(({ chain, tag }) => `db:migrate: applied ${tag} (${chain})`);
  process.stdout.write(`${[...lines, `db:migrate: ${String(applied.length)} migration(s) applied`].join("\n")}\n`);
} catch (error) {
  process.stderr.write(`db:migrate: ${error instanceof Error ? error.message : "failed"}\n`);
  process.exit(1);
}
