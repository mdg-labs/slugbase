// Where `pnpm db:seed` may write (doc 08 section 1.4): the development Postgres of compose.dev.yml and nothing else.
// The check is closed: a value it cannot read, a host or port other than the published ones, another database or a
// role other than the migrator is refused, and nothing connects before it has passed.

/** The published address and database of compose.dev.yml (`127.0.0.1:54329`, `POSTGRES_DB`). */
export const DEVELOPMENT_DATABASE = { host: "127.0.0.1", aliases: ["localhost"], port: 54329, name: "slugbase_dev" } as const;

const MIGRATOR_ROLE = "slugbase_migrator";

/** A connection the seed script may use. */
export interface SeedConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

export class SeedTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedTargetError";
  }
}

function parse(name: string, value: string | undefined): URL {
  if (value === undefined || value === "") {
    throw new SeedTargetError(`${name} is not set; run pnpm dev:env, which copies the development values to .env`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SeedTargetError(`${name} is not a valid connection URL`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new SeedTargetError(`${name} is not a PostgreSQL connection URL`);
  }
  const hosts: readonly string[] = [DEVELOPMENT_DATABASE.host, ...DEVELOPMENT_DATABASE.aliases];
  if (!hosts.includes(url.hostname) || url.port !== String(DEVELOPMENT_DATABASE.port)) {
    throw new SeedTargetError(`${name} does not point at the development database ${DEVELOPMENT_DATABASE.host}:${String(DEVELOPMENT_DATABASE.port)} of compose.dev.yml; seeding writes there only`);
  }
  // An option in the query (`?host=`) could send libpq somewhere else than the address checked above.
  if (url.pathname !== `/${DEVELOPMENT_DATABASE.name}` || url.search !== "" || url.hash !== "") {
    throw new SeedTargetError(`${name} must name the database ${DEVELOPMENT_DATABASE.name} and carry no options`);
  }
  return url;
}

/**
 * The connection `pnpm db:seed` writes through, or the reason it refuses. `DATABASE_URL` and `DATABASE_MIGRATE_URL`
 * must both name the development database; the seed connects with the second, as the migrator, because the application
 * role may not write the accounts, the usage of a bookmark or a workspace's counter.
 */
export function developmentTarget(env: Readonly<Record<string, string | undefined>>): SeedConnection {
  parse("DATABASE_URL", env["DATABASE_URL"]);
  const migrate = parse("DATABASE_MIGRATE_URL", env["DATABASE_MIGRATE_URL"]);
  const username = decodeURIComponent(migrate.username);
  if (username !== MIGRATOR_ROLE) {
    throw new SeedTargetError(`DATABASE_MIGRATE_URL must connect as ${MIGRATOR_ROLE}`);
  }
  return {
    host: DEVELOPMENT_DATABASE.host,
    port: DEVELOPMENT_DATABASE.port,
    database: DEVELOPMENT_DATABASE.name,
    username,
    password: decodeURIComponent(migrate.password),
  };
}
