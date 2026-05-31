import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type {
  DrizzleClient,
  PostgresDrizzleClient,
  SqliteDrizzleClient,
} from "../db/dialect/create-client.js";
import type { DbDialect } from "../db/dialect/dialect.js";
import { userAccounts as sqliteUserAccounts } from "../db/schema/index.js";
import { userAccounts as pgUserAccounts } from "../db/schema/pg-index.js";
import type { AccountRecord, CreateAccountData } from "./account.types.js";

function nowMs(): number {
  return Date.now();
}

function toRecord(row: {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  language: string;
  theme: string;
  isInstanceAdmin: boolean | number;
  mfaState: string;
  aiOptOut: boolean | number;
  emailVerified: boolean | number;
  createdAt: Date | number;
  updatedAt: Date | number;
}): AccountRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.passwordHash,
    language: row.language,
    theme: row.theme,
    isInstanceAdmin: Boolean(row.isInstanceAdmin),
    mfaState: row.mfaState as AccountRecord["mfaState"],
    aiOptOut: Boolean(row.aiOptOut),
    emailVerified: Boolean(row.emailVerified),
    createdAt: new Date(
      row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    ),
    updatedAt: new Date(
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
    ),
  };
}

export class AccountRepository {
  constructor(
    private readonly db: DrizzleClient,
    private readonly dialect: DbDialect,
  ) {}

  async create(data: CreateAccountData): Promise<AccountRecord> {
    const id = randomUUID();
    const now = nowMs();

    const values = {
      id,
      email: data.email,
      name: data.name,
      passwordHash: data.passwordHash,
      language: data.language ?? "en",
      theme: data.theme ?? "auto",
      isInstanceAdmin: data.isInstanceAdmin ?? false,
      mfaState: "not_enrolled",
      aiOptOut: data.aiOptOut ?? false,
      emailVerified: false,
    };

    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      sqliteDb
        .insert(sqliteUserAccounts)
        .values({
          ...values,
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .run();

      const row = sqliteDb
        .select()
        .from(sqliteUserAccounts)
        .where(eq(sqliteUserAccounts.id, id))
        .get();

      if (!row) throw new Error("Failed to create account");
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .insert(pgUserAccounts)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning();

    const row = rows[0];
    if (!row) throw new Error("Failed to create account");
    return toRecord(row);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteUserAccounts)
        .where(eq(sqliteUserAccounts.email, email))
        .get();
      if (!row) return null;
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgUserAccounts)
      .where(eq(pgUserAccounts.email, email))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async findById(id: string): Promise<AccountRecord | null> {
    if (this.dialect === "sqlite") {
      const sqliteDb = this.db as SqliteDrizzleClient;
      const row = sqliteDb
        .select()
        .from(sqliteUserAccounts)
        .where(eq(sqliteUserAccounts.id, id))
        .get();
      if (!row) return null;
      return toRecord(row);
    }

    const pgDb = this.db as PostgresDrizzleClient;
    const rows = await pgDb
      .select()
      .from(pgUserAccounts)
      .where(eq(pgUserAccounts.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }
}
