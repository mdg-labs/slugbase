import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../../db/dialect/create-client.js";
import type { DbDialect } from "../../db/dialect/dialect.js";
import { oidcAccounts as sqliteOidcAccounts } from "../../db/schema/index.js";
import { oidcProviders as sqliteOidcProviders } from "../../db/schema/index.js";
import { oidcAccounts as pgOidcAccounts } from "../../db/schema/pg-index.js";
import { oidcProviders as pgOidcProviders } from "../../db/schema/pg-index.js";
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
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async findProviderById(id: string): Promise<OidcProviderRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteOidcProviders)
        .where(eq(sqliteOidcProviders.id, id))
        .get();
      if (!row) return null;
      return toProviderRecord(row);
    }
    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgOidcProviders)
      .where(eq(pgOidcProviders.id, id))
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteOidcProviders)
        .values({
          id,
          name: data.name,
          issuerUrl: data.issuerUrl,
          clientId: data.clientId,
          clientSecretEncrypted: data.clientSecretEncrypted,
          scopes: data.scopes ?? "openid email profile",
          enabled: data.enabled ?? true,
          createdAt: new Date(now),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteOidcProviders)
        .where(eq(sqliteOidcProviders.id, id))
        .get();
      if (!row) throw new Error("Failed to create OIDC provider");
      return toProviderRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgOidcProviders)
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
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteOidcAccounts)
        .where(
          and(
            eq(sqliteOidcAccounts.providerId, providerId),
            eq(sqliteOidcAccounts.subject, subject),
          ),
        )
        .get();
      if (!row) return null;
      return toAccountRecord(row);
    }
    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgOidcAccounts)
      .where(
        and(
          eq(pgOidcAccounts.providerId, providerId),
          eq(pgOidcAccounts.subject, subject),
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

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteOidcAccounts)
        .values({
          id,
          userId: data.userId,
          providerId: data.providerId,
          subject: data.subject,
          createdAt: new Date(now),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteOidcAccounts)
        .where(eq(sqliteOidcAccounts.id, id))
        .get();
      if (!row) throw new Error("Failed to create OIDC account");
      return toAccountRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgOidcAccounts)
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
