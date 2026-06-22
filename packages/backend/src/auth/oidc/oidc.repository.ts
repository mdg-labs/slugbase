import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { oidcAccounts } from "../../db/schema/index.js";
import type { CreateOidcAccountData, OidcAccountRecord } from "./oidc.types.js";

function toAccountRecord(row: {
  id: string;
  userId: string;
  providerId: string;
  subject: string;
  createdAt: Date | number;
}): OidcAccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    providerId: row.providerId,
    subject: row.subject,
    createdAt: new Date(
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    ),
  };
}

export class OidcRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findAccountByProviderAndSubject(
    providerId: string,
    subject: string,
  ): Promise<OidcAccountRecord | null> {
    const rows = await this.db
      .select()
      .from(oidcAccounts)
      .where(
        and(
          eq(oidcAccounts.providerId, providerId),
          eq(oidcAccounts.subject, subject),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toAccountRecord(row);
  }

  async createAccount(data: CreateOidcAccountData): Promise<OidcAccountRecord> {
    const id = randomUUID();
    const now = Date.now();

    const rows = await this.db
      .insert(oidcAccounts)
      .values({
        id,
        userId: data.userId,
        providerId: data.providerId,
        subject: data.subject,
        createdAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create OIDC account");
    return toAccountRecord(row);
  }
}
