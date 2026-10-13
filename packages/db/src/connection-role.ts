import postgres from "postgres";

// What the role of a connection can do to the tenant boundary (doc 05 section
// 3.1, Q56). The application role owns nothing and has no BYPASSRLS; a
// superuser, or the role that owns the database, is not held by row-level
// security the way that role is, so a server connected as one runs without it.
// Read-only: it changes nothing in the database.

export interface ConnectionRoleOptions {
  /** Connection URL of the role to inspect (`DATABASE_URL`). */
  url: string;
}

export interface ConnectionRole {
  /** The role the session runs as. */
  role: string;
  /** Whether it is a superuser. */
  superuser: boolean;
  /** Whether it owns the database it is connected to. */
  ownsDatabase: boolean;
}

/**
 * The inspection failed. The message and `code` (a SQLSTATE or a Node error
 * code, when there is one) never contain the connection string or the
 * password, and the driver's own error is not kept as `cause`.
 */
export class ConnectionRoleError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ConnectionRoleError";
    this.code = code;
  }
}

const CONNECT_TIMEOUT_SECONDS = 10;

function secretsOf(url: string): string[] {
  const parsed = new URL(url);
  const secrets = new Set<string>([url, parsed.href]);
  if (parsed.password !== "") {
    secrets.add(parsed.password);
    try {
      secrets.add(decodeURIComponent(parsed.password));
    } catch {
      // An undecodable password has no other form to redact.
    }
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join("***");
  }
  return result;
}

/**
 * Reads whether the role of `DATABASE_URL` is a superuser (`pg_roles.rolsuper`)
 * and whether it owns the current database (`pg_database.datdba`). A failure to
 * read it rejects: it never means the role is safe.
 */
export async function connectionRole(options: ConnectionRoleOptions): Promise<ConnectionRole> {
  let secrets: string[];
  try {
    const protocol = new URL(options.url).protocol;
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      throw new Error("not a PostgreSQL URL");
    }
    secrets = secretsOf(options.url);
  } catch {
    throw new ConnectionRoleError("the database URL is not a valid PostgreSQL connection URL");
  }
  const sql = postgres(options.url, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    onnotice: () => undefined,
    connection: { application_name: "slugbase-connection-role" },
  });
  try {
    const rows = await sql<{ role: string; superuser: boolean; owns_database: boolean }[]>`
      SELECT r.rolname AS role, r.rolsuper AS superuser, d.datdba = r.oid AS owns_database
        FROM pg_roles r, pg_database d
       WHERE r.rolname = current_user AND d.datname = current_database()`;
    const row = rows[0];
    if (row === undefined) {
      throw new ConnectionRoleError("the database did not report the role of the connection");
    }
    return { role: row.role, superuser: row.superuser, ownsDatabase: row.owns_database };
  } catch (error) {
    if (error instanceof ConnectionRoleError) {
      throw error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error && error.message !== "" ? error.message : "unknown error";
    throw new ConnectionRoleError(
      redact(message, secrets),
      typeof code === "string" ? redact(code, secrets) : undefined,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}
