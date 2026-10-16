import { and, desc, eq, lt } from "drizzle-orm";
import { accountIdentities } from "../schema/identities.ts";
import { tenantHandle, type TenantTx } from "../tenant.ts";

// The identities linked to the signed-in account (doc 05 section 2.1, doc 04 section 10.3), read in an
// account-level transaction on the own-account policy of `account_identities` (T1): an account lists its own
// identities only. `slugbase_app` may select the columns below and no other (never the provider's subject)
// and writes none; linking, unlinking and recording a use are system operations (src/sql/180-identity-management.sql).
// The account predicate here is the application layer on top of that policy.

/** An identity as it is shown: never the provider's subject. */
export interface AccountIdentity {
  readonly id: string;
  /** The slug of the provider. */
  readonly provider: string;
  /** The address the provider asserted when the identity was linked. */
  readonly emailAtLink: string;
  readonly createdAt: Date;
  /** When the identity last signed in or re-authenticated the account; null when it never has. */
  readonly lastUsedAt: Date | null;
}

export interface AccountIdentityRepository {
  /** The account's identities, newest first, `limit` of them after the identity `afterId` (the first page when null). */
  list(afterId: string | null, limit: number): Promise<readonly AccountIdentity[]>;
}

export function accountIdentityRepository(tx: TenantTx): AccountIdentityRepository {
  return {
    async list(afterId, limit) {
      return tenantHandle(tx)
        .select({
          id: accountIdentities.id,
          provider: accountIdentities.provider,
          emailAtLink: accountIdentities.emailAtLink,
          createdAt: accountIdentities.createdAt,
          lastUsedAt: accountIdentities.lastUsedAt,
        })
        .from(accountIdentities)
        .where(and(eq(accountIdentities.accountId, tx.accountId), afterId === null ? undefined : lt(accountIdentities.id, afterId)))
        .orderBy(desc(accountIdentities.id))
        .limit(limit);
    },
  };
}
