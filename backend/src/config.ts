/**
 * Core config from environment. Used by app entrypoints and by @slugbase/core/backend.
 */

export interface DbConfig {
  type: 'sqlite' | 'postgresql';
  path?: string;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface CoreConfig {
  baseUrl: string;
  frontendUrl: string;
  db: DbConfig;
  jwtSecret: string;
  encryptionKey: string;
  sessionSecret: string;
  nodeEnv: string;
  registrationsEnabled: boolean;
  port: number;
}

const DEFAULT_PORT = 5000;
const DEFAULT_FRONTEND = 'http://localhost:3000';
const DEFAULT_BASE = 'http://localhost:5000';

/**
 * Read and return typed config from env. Does not validate secrets (use validateEnvironmentVariables for that).
 */
export function getConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const dbType = (env.DB_TYPE || 'sqlite') as 'sqlite' | 'postgresql';
  const db: DbConfig = { type: dbType };
  if (dbType === 'postgresql') {
    if (env.DATABASE_URL) {
      db.connectionString = env.DATABASE_URL;
    } else {
      db.host = env.DB_HOST || 'localhost';
      db.port = parseInt(env.DB_PORT || '5432', 10);
      db.database = env.DB_NAME || 'slugbase';
      db.user = env.DB_USER || 'postgres';
      db.password = env.DB_PASSWORD || '';
    }
  } else {
    db.path = env.DB_PATH;
  }

  const sessionSecret = env.SESSION_SECRET || env.JWT_SECRET || 'slugbase-session-secret-change-in-production';
  return {
    baseUrl: env.BASE_URL || DEFAULT_BASE,
    frontendUrl: (env.FRONTEND_URL || DEFAULT_FRONTEND).replace(/\/$/, ''),
    db,
    jwtSecret: (env.JWT_SECRET || '') as string,
    encryptionKey: (env.ENCRYPTION_KEY || '') as string,
    sessionSecret,
    nodeEnv: env.NODE_ENV || 'development',
    registrationsEnabled: env.REGISTRATIONS_ENABLED !== 'false',
    port: parseInt(env.PORT || String(DEFAULT_PORT), 10),
  };
}
