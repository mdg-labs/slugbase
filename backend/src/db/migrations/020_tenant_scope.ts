import { execute } from '../index.js';

export const migrationId = '020';
export const migrationName = 'Add tenant_id columns and tenant indexes';

const TENANT_TABLES = [
  'bookmarks',
  'folders',
  'tags',
  'teams',
  'bookmark_folders',
  'bookmark_tags',
  'team_members',
  'bookmark_team_shares',
  'folder_team_shares',
  'bookmark_user_shares',
  'folder_user_shares',
  'slug_preferences',
  'api_tokens',
  'ai_suggestions_cache',
  'ai_suggestion_usage',
  'oidc_providers',
  'system_config',
];

async function addTenantColumnsSqlite() {
  for (const table of TENANT_TABLES) {
    try {
      await execute(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`, []);
    } catch (error: any) {
      if (!error.message?.includes('duplicate column name')) throw error;
    }
  }
}

async function addTenantColumnsPostgres() {
  for (const table of TENANT_TABLES) {
    await execute(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`, []);
  }
}

async function createTenantIndexes() {
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmarks_tenant_user ON bookmarks(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmarks_tenant_slug ON bookmarks(tenant_id, slug)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_folders_tenant_user ON folders(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_tags_tenant_user ON tags(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_team_members_tenant_user ON team_members(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmark_folders_tenant_bookmark ON bookmark_folders(tenant_id, bookmark_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tenant_bookmark ON bookmark_tags(tenant_id, bookmark_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmark_team_shares_tenant_bookmark ON bookmark_team_shares(tenant_id, bookmark_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_folder_team_shares_tenant_folder ON folder_team_shares(tenant_id, folder_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_bookmark_user_shares_tenant_bookmark ON bookmark_user_shares(tenant_id, bookmark_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_folder_user_shares_tenant_folder ON folder_user_shares(tenant_id, folder_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_slug_preferences_tenant_user_slug ON slug_preferences(tenant_id, user_id, slug)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant_user ON api_tokens(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestions_cache_tenant_user ON ai_suggestions_cache(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_ai_suggestion_usage_tenant_user ON ai_suggestion_usage(tenant_id, user_id)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_oidc_providers_tenant_key ON oidc_providers(tenant_id, provider_key)`, []);
  await execute(`CREATE INDEX IF NOT EXISTS idx_system_config_tenant_key ON system_config(tenant_id, key)`, []);
}

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await addTenantColumnsPostgres();
    // Tenant-scoped uniqueness (kept additive to preserve compatibility with existing installs)
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_bookmarks_tenant_slug ON bookmarks(tenant_id, slug) WHERE slug IS NOT NULL`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_folders_tenant_user_name ON folders(tenant_id, user_id, name)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_tenant_user_name ON tags(tenant_id, user_id, name)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_slug_preferences_tenant_user_slug ON slug_preferences(tenant_id, user_id, slug)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_oidc_providers_tenant_key ON oidc_providers(tenant_id, provider_key)`, []);
  } else {
    await addTenantColumnsSqlite();
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_bookmarks_tenant_slug ON bookmarks(tenant_id, slug) WHERE slug IS NOT NULL`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_folders_tenant_user_name ON folders(tenant_id, user_id, name)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_tenant_user_name ON tags(tenant_id, user_id, name)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_slug_preferences_tenant_user_slug ON slug_preferences(tenant_id, user_id, slug)`, []);
    await execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_oidc_providers_tenant_key ON oidc_providers(tenant_id, provider_key)`, []);
  }

  await createTenantIndexes();
}

export async function down() {
  await execute(`DROP INDEX IF EXISTS idx_system_config_tenant_key`, []);
  await execute(`DROP INDEX IF EXISTS idx_oidc_providers_tenant_key`, []);
  await execute(`DROP INDEX IF EXISTS idx_ai_suggestion_usage_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_ai_suggestions_cache_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_api_tokens_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_slug_preferences_tenant_user_slug`, []);
  await execute(`DROP INDEX IF EXISTS idx_folder_user_shares_tenant_folder`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmark_user_shares_tenant_bookmark`, []);
  await execute(`DROP INDEX IF EXISTS idx_folder_team_shares_tenant_folder`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmark_team_shares_tenant_bookmark`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmark_tags_tenant_bookmark`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmark_folders_tenant_bookmark`, []);
  await execute(`DROP INDEX IF EXISTS idx_team_members_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_teams_tenant`, []);
  await execute(`DROP INDEX IF EXISTS idx_tags_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_folders_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmarks_tenant_slug`, []);
  await execute(`DROP INDEX IF EXISTS idx_bookmarks_tenant_user`, []);
  await execute(`DROP INDEX IF EXISTS ux_oidc_providers_tenant_key`, []);
  await execute(`DROP INDEX IF EXISTS ux_slug_preferences_tenant_user_slug`, []);
  await execute(`DROP INDEX IF EXISTS ux_tags_tenant_user_name`, []);
  await execute(`DROP INDEX IF EXISTS ux_folders_tenant_user_name`, []);
  await execute(`DROP INDEX IF EXISTS ux_bookmarks_tenant_slug`, []);
}
