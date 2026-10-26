import { createInterface } from "node:readline";
import { createTestDatabase, useCluster, type ClusterUse, type TestDatabase } from "../../src/testing.ts";

// One process that behaves like a test file of another run, driven line by line
// from stdin and answering on stdout. `use` holds the cluster the way a test
// file does for its whole run, `lock-exclusive` and `unlock-exclusive` change
// the roles of the cluster for a step, `database` and `drop-database` hold and
// give back a test database, and `exit` ends the process.

let cluster: ClusterUse | undefined;
let unlock: (() => Promise<void>) | undefined;
let database: TestDatabase | undefined;

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

for await (const line of createInterface({ input: process.stdin })) {
  switch (line) {
    case "use":
      cluster = await useCluster();
      say("using");
      break;
    case "lock-exclusive":
      unlock = await cluster?.lockExclusive();
      say("exclusive");
      break;
    case "unlock-exclusive":
      await unlock?.();
      say("shared");
      break;
    case "database":
      database = await createTestDatabase();
      say("database");
      break;
    case "drop-database":
      await database?.drop();
      say("dropped");
      break;
    case "exit":
      await cluster?.release();
      say("exited");
      process.exit(0);
  }
}
