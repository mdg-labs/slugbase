import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { bigint } from "drizzle-orm/pg-core";

export const oidcProviders = pgTable(
  "oidc_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    clientId: text("client_id").notNull(),
    /** AES-GCM encrypted via CryptoService (spec §11.11) - never stored or logged as plaintext */
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    /** Space-separated list of OIDC scopes, e.g. "openid email profile" */
    scopes: text("scopes").notNull().default("openid email profile"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("oidc_providers_enabled_idx").on(t.enabled),
    uniqueIndex("oidc_providers_issuer_url_client_id_unique_idx").on(
      t.issuerUrl,
      t.clientId,
    ),
  ],
);
