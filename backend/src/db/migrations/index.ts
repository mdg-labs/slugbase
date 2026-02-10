/**
 * Auto-registered migrations
 * All migration files in this directory should export:
 * - migrationId: string (unique identifier)
 * - migrationName: string (human-readable name)
 * - up: () => Promise<void> (migration function)
 * - down?: () => Promise<void> (optional rollback function)
 * 
 * To add a new migration:
 * 1. Create a new file with format: NNN_migration_name.ts
 * 2. Export migrationId, migrationName, up, and optionally down
 * 3. Import it below and add to the migrations array
 */

import { execute, query } from '../index.js';
import * as migration001 from './001_migrate_slug_nullable.js';
import * as migration002 from './002_add_oidc_custom_endpoints.js';
import * as migration003 from './003_add_bookmark_features.js';
import * as migration004 from './004_make_slug_globally_unique.js';
import * as migration005 from './005_add_email_verification.js';
import * as migration006 from './006_refresh_tokens.js';

export interface Migration {
  migrationId: string;
  migrationName: string;
  up: () => Promise<void>;
  down?: () => Promise<void>;
}

// Register all migrations here (sorted by migrationId)
const migrations: Migration[] = [
  {
    migrationId: migration001.migrationId,
    migrationName: migration001.migrationName,
    up: migration001.up,
    down: migration001.down,
  },
  {
    migrationId: migration002.migrationId,
    migrationName: migration002.migrationName,
    up: migration002.up,
    down: migration002.down,
  },
  {
    migrationId: migration003.migrationId,
    migrationName: migration003.migrationName,
    up: migration003.up,
    down: migration003.down,
  },
  {
    migrationId: migration004.migrationId,
    migrationName: migration004.migrationName,
    up: migration004.up,
    down: migration004.down,
  },
  {
    migrationId: migration005.migrationId,
    migrationName: migration005.migrationName,
    up: migration005.up,
    down: migration005.down,
  },
  {
    migrationId: migration006.migrationId,
    migrationName: migration006.migrationName,
    up: migration006.up,
    down: migration006.down,
  },
];

// Ensure migrations table exists
async function ensureMigrationsTable() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';
  
  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id VARCHAR(255) PRIMARY KEY,
        migration_name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        migration_name TEXT NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, []);
  }
}

// Get applied migrations
async function getAppliedMigrations(): Promise<string[]> {
  try {
    const results = await query('SELECT migration_id FROM schema_migrations ORDER BY migration_id', []);
    return results.map((r: any) => r.migration_id);
  } catch (error: any) {
    // Table might not exist yet
    if (error.message?.includes('no such table') || error.message?.includes('does not exist')) {
      return [];
    }
    throw error;
  }
}

// Record migration as applied
async function recordMigration(migrationId: string, migrationName: string) {
  await execute(
    'INSERT INTO schema_migrations (migration_id, migration_name) VALUES (?, ?)',
    [migrationId, migrationName]
  );
}

// Run all pending migrations
export async function runMigrations() {
  console.log('Checking for pending migrations...');
  
  await ensureMigrationsTable();
  const appliedMigrations = await getAppliedMigrations();
  
  // Sort migrations by migrationId to ensure correct order
  const sortedMigrations = migrations.sort((a, b) => 
    a.migrationId.localeCompare(b.migrationId)
  );
  
  const pendingMigrations = sortedMigrations.filter(
    m => !appliedMigrations.includes(m.migrationId)
  );
  
  if (pendingMigrations.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  
  console.log(`Found ${pendingMigrations.length} pending migration(s):`);
  
  for (const migration of pendingMigrations) {
    try {
      console.log(`Running migration: ${migration.migrationId} - ${migration.migrationName}`);
      await migration.up();
      await recordMigration(migration.migrationId, migration.migrationName);
      console.log(`✓ Migration ${migration.migrationId} applied successfully`);
    } catch (error) {
      console.error(`✗ Migration ${migration.migrationId} failed:`, error);
      throw error;
    }
  }
  
  console.log('All migrations completed successfully.');
}

// Get all migrations (for listing)
export function getAllMigrations(): Migration[] {
  return migrations.sort((a, b) => a.migrationId.localeCompare(b.migrationId));
}