import { execute } from '../index.js';

export const migrationId = '010';
export const migrationName = 'Organizations for Cloud billing';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      CREATE TABLE IF NOT EXISTS organizations (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        plan VARCHAR(50) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        included_seats INTEGER DEFAULT 5,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `, []);

    await execute(`
      CREATE TABLE IF NOT EXISTS org_members (
        user_id VARCHAR(255) NOT NULL,
        org_id VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, org_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`
      CREATE TABLE IF NOT EXISTS org_invitations (
        id VARCHAR(255) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        invited_by VARCHAR(255) NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations(org_id)`, []);
  } else {
    await execute(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        included_seats INTEGER DEFAULT 5,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `, []);

    await execute(`
      CREATE TABLE IF NOT EXISTS org_members (
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, org_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`
      CREATE TABLE IF NOT EXISTS org_invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
        FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token)`, []);
    await execute(`CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON org_invitations(org_id)`, []);
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`DROP INDEX IF EXISTS idx_org_invitations_org`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_invitations_token`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_members_user`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_members_org`, []);
    await execute(`DROP TABLE IF EXISTS org_invitations`, []);
    await execute(`DROP TABLE IF EXISTS org_members`, []);
    await execute(`DROP TABLE IF EXISTS organizations`, []);
  } else {
    await execute(`DROP INDEX IF EXISTS idx_org_invitations_org`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_invitations_token`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_members_user`, []);
    await execute(`DROP INDEX IF EXISTS idx_org_members_org`, []);
    await execute(`DROP TABLE IF EXISTS org_invitations`, []);
    await execute(`DROP TABLE IF EXISTS org_members`, []);
    await execute(`DROP TABLE IF EXISTS organizations`, []);
  }
}
