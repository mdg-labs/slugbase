import { coerceCount } from "../db/coerce-count.js";
import { randomUUID } from "node:crypto";

import { count, eq } from "drizzle-orm";

import type { DrizzleClient } from "../db/dialect/create-client.js";
import { userAccounts } from "../db/schema/index.js";
import type {
  AccountRecord,
  CreateAccountData,
  CreateOidcAccountRepoData,
} from "./account.types.js";

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
  accentColor: string | null;
  isInstanceAdmin: boolean | number;
  mfaState: string;
  mfaTotpSecretEncrypted: string | null;
  aiOptOut: boolean | number;
  defaultBookmarkView: string;
  pendingEmail: string | null;
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
    accentColor: row.accentColor ?? null,
    isInstanceAdmin: Boolean(row.isInstanceAdmin),
    mfaState: row.mfaState as AccountRecord["mfaState"],
    mfaTotpSecretEncrypted: row.mfaTotpSecretEncrypted ?? null,
    aiOptOut: Boolean(row.aiOptOut),
    defaultBookmarkView:
      row.defaultBookmarkView === "table" ? "table" : "grid",
    pendingEmail: row.pendingEmail ?? null,
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
  constructor(private readonly db: DrizzleClient) {}

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

        const rows = await this.db
      .insert(userAccounts)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning();

    const row = rows[0];
    if (!row) throw new Error("Failed to create account");
    return toRecord(row);
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {

        const rows = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.email, email))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async findById(id: string): Promise<AccountRecord | null> {

        const rows = await this.db
      .select()
      .from(userAccounts)
      .where(eq(userAccounts.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toRecord(row);
  }

  async countAll(): Promise<number> {

        const rows = await this.db.select({ value: count() }).from(userAccounts);
    return coerceCount(rows[0]?.value);
  }

  async updateMfa(
    id: string,
    patch: { mfaState: string; mfaTotpSecretEncrypted?: string | null },
  ): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ ...patch, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async updateEmailVerified(id: string, emailVerified: boolean): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ emailVerified, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async updateEmail(id: string, email: string): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ email, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ passwordHash, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async updateProfile(id: string, patch: { name: string }): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ name: patch.name, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async updatePreferences(
    id: string,
    patch: {
      language?: string;
      theme?: string;
      accentColor?: string | null;
      aiOptOut?: boolean;
      defaultBookmarkView?: string;
    },
  ): Promise<void> {
    const updatedAt = Date.now();
    const values: Record<string, unknown> = { updatedAt };

    if (patch.language !== undefined) values["language"] = patch.language;
    if (patch.theme !== undefined) values["theme"] = patch.theme;
    if (patch.accentColor !== undefined) values["accentColor"] = patch.accentColor;
    if (patch.aiOptOut !== undefined) values["aiOptOut"] = patch.aiOptOut;
    if (patch.defaultBookmarkView !== undefined) {
      values["defaultBookmarkView"] = patch.defaultBookmarkView;
    }

        await this.db
      .update(userAccounts)
      .set({ ...values, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  async setPendingEmail(id: string, pendingEmail: string | null): Promise<void> {
    const updatedAt = Date.now();

        await this.db
      .update(userAccounts)
      .set({ pendingEmail, updatedAt })
      .where(eq(userAccounts.id, id));
  }

  /**
   * Creates an account for a federated (OIDC) user.
   * Uses a sentinel password hash so the row satisfies the NOT NULL constraint;
   * direct password auth will never succeed for this account.
   */
  async createOidc(data: CreateOidcAccountRepoData): Promise<AccountRecord> {
    const id = randomUUID();
    const now = nowMs();
    const OIDC_SENTINEL_HASH = "oidc:no-password";

    const values = {
      id,
      email: data.email,
      name: data.name,
      passwordHash: OIDC_SENTINEL_HASH,
      language: data.language ?? "en",
      theme: data.theme ?? "auto",
      isInstanceAdmin: false,
      mfaState: "not_enrolled",
      aiOptOut: false,
      emailVerified: data.emailVerified,
    };

        const rows = await this.db
      .insert(userAccounts)
      .values({ ...values, createdAt: now, updatedAt: now })
      .returning();

    const row = rows[0];
    if (!row) throw new Error("Failed to create OIDC account");
    return toRecord(row);
  }
}
