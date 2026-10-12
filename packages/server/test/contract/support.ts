import type { Database } from "@slugbase/db";
import type { TestDatabase } from "@slugbase/testing/db";

/** The URL the server reads the migration level through: the app role of the test database. */
export function appUrl(database: TestDatabase): string {
  const { options } = database.app;
  const url = new URL("postgres://localhost");
  url.hostname = String(options.host[0]);
  url.port = String(options.port[0]);
  url.username = options.user;
  url.password = String(options.pass);
  url.pathname = `/${options.database}`;
  return url.href;
}

/** The tenant database of a server under test: transactions on the test database, whose pools its owner closes. */
export function tenantDatabase(database: TestDatabase): Database {
  return { withTenant: (context, fn) => database.tenant.withTenant(context, fn), close: () => Promise.resolve() };
}
