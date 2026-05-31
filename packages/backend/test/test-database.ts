import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDatabaseHandle {
  databaseUrl: string;
  cleanup: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const configured = process.env.DATABASE_URL?.trim();

  if (configured) {
    return {
      databaseUrl: configured,
      cleanup: async () => {},
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "slugbase-db-"));
  const dbPath = join(tempDir, "test.sqlite");

  return {
    databaseUrl: `sqlite://${dbPath}`,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
