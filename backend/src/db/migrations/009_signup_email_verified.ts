import { execute, query } from '../index.js';

export const migrationId = '009';
export const migrationName = 'Signup email verified and verification tokens';

export async function up() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE
    `, []);

    await execute(`
      CREATE TABLE IF NOT EXISTS signup_verification_tokens (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        token VARCHAR(255) UNIQUE NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_token
      ON signup_verification_tokens(token)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_expires
      ON signup_verification_tokens(expires_at)
    `, []);
  } else {
    const tableInfo = await query('PRAGMA table_info(users)', []);
    const hasEmailVerified = (tableInfo as any[]).some((col: any) => col.name === 'email_verified');
    if (!hasEmailVerified) {
      try {
        await execute(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 1`, []);
      } catch (error: any) {
        if (!error.message?.includes('duplicate column name')) {
          throw error;
        }
      }
    }

    await execute(`
      CREATE TABLE IF NOT EXISTS signup_verification_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `, []);

    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_token
      ON signup_verification_tokens(token)
    `, []);
    await execute(`
      CREATE INDEX IF NOT EXISTS idx_signup_verification_tokens_expires
      ON signup_verification_tokens(expires_at)
    `, []);
  }
}

export async function down() {
  const DB_TYPE = process.env.DB_TYPE || 'sqlite';

  if (DB_TYPE === 'postgresql') {
    await execute(`DROP INDEX IF EXISTS idx_signup_verification_tokens_expires`, []);
    await execute(`DROP INDEX IF EXISTS idx_signup_verification_tokens_token`, []);
    await execute(`DROP TABLE IF EXISTS signup_verification_tokens`, []);
    await execute(`ALTER TABLE users DROP COLUMN IF EXISTS email_verified`, []);
  } else {
    await execute(`DROP INDEX IF EXISTS idx_signup_verification_tokens_expires`, []);
    await execute(`DROP INDEX IF EXISTS idx_signup_verification_tokens_token`, []);
    await execute(`DROP TABLE IF EXISTS signup_verification_tokens`, []);
  }
}
