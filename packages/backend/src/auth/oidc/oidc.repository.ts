import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../../db/dialect/create-client.js";
import { oidcAccounts, oidcProviders } from "../../db/schema/index.js";
import type {
  CreateOidcAccountData,
  CreateOidcProviderData,
  OidcAccountRecord,
  OidcProviderRecord,
} from "./oidc.types.js";

function toProviderRecord(row: {
  id: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecretEncrypted: string;
  scopes: string;
  enabled: boolean | number;
  createdAt: Date | number;
}): OidcProviderRecord {
  return {
    id: row.id,
    name: row.name,
    issuerUrl: row.issuerUrl,
    clientId: row.clientId,
    clientSecretEncrypted: row.clientSecretEncrypted,
    scopes: row.scopes,
    enabled: Boolean(row.enabled),
    createdAt: new Date(
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    ),
  };
}

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

  async findProviderById(id: string): Promise<OidcProviderRecord | null> {

    const rows = await this.db
      .select()
      .from(oidcProviders)
      .where(eq(oidcProviders.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toProviderRecord(row);
  }

  async createProvider(
    data: CreateOidcProviderData,
  ): Promise<OidcProviderRecord> {
    const id = randomUUID();
    const now = Date.now();

        const rows = await this.db
      .insert(oidcProviders)
      .values({
        id,
        name: data.name,
        issuerUrl: data.issuerUrl,
        clientId: data.clientId,
        clientSecretEncrypted: data.clientSecretEncrypted,
        scopes: data.scopes ?? "openid email profile",
        enabled: data.enabled ?? true,
        createdAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create OIDC provider");
    return toProviderRecord(row);
  }

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
