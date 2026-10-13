import { connectionRole } from "@slugbase/db";
import type { Logger } from "../create-server.ts";

// Q56 and doc 05 section 3.1: the application role owns nothing and has no
// BYPASSRLS. A connection as a superuser or as the owner of the database is
// not held by row-level security the way that role is, so a server running as
// one silently serves without the isolation between workspaces (D8, T1).

export interface ApplicationRoleCheck {
  /** `DATABASE_URL`. */
  readonly url: string;
  /** `SLUGBASE_ALLOW_OWNER_CONNECTION`. */
  readonly allowOwnerConnection: boolean;
  readonly logger: Logger;
}

/** The server's role is a superuser or owns the database, and the operator did not allow it. */
export class OwnerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerConnectionError";
  }
}

/**
 * Refuses a `DATABASE_URL` whose role is a superuser or owns the database, unless
 * `SLUGBASE_ALLOW_OWNER_CONNECTION` allows it, which logs a warning instead. A
 * role that cannot be read is refused too: a check that fails is never "fine".
 */
export async function assertApplicationRole(check: ApplicationRoleCheck): Promise<void> {
  const role = await connectionRole({ url: check.url });
  if (!role.superuser && !role.ownsDatabase) {
    return;
  }
  const privilege = [role.superuser ? "is a superuser" : undefined, role.ownsDatabase ? "owns the database" : undefined]
    .filter((part) => part !== undefined)
    .join(" and ");
  if (check.allowOwnerConnection) {
    check.logger.warn(
      "SLUGBASE_ALLOW_OWNER_CONNECTION is set: the application role is not held by row-level security, so nothing in the database separates one workspace from another",
      { role: role.role, superuser: role.superuser, ownsDatabase: role.ownsDatabase },
    );
    return;
  }
  throw new OwnerConnectionError(
    `DATABASE_URL connects as the role ${role.role}, which ${privilege}, so row-level security does not hold it. ` +
      "Connect the server as the unprivileged application role slugbase_app with DATABASE_URL, and give DATABASE_MIGRATE_URL " +
      "the migrator role slugbase_migrator, which applies the migrations (the roles are provisioned by packages/db/provision/roles.sql). " +
      "To run with this role anyway, set SLUGBASE_ALLOW_OWNER_CONNECTION=true.",
  );
}
