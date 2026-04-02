/**
 * AI suggestions feature flag logic.
 * When OPENAI_API_KEY env is set, API key and model come from env (global); ai_enabled remains per-tenant in system_config.
 */

import { queryOne } from '../db/index.js';

const ENV_API_KEY = (process.env.OPENAI_API_KEY ?? '').trim();
const ENV_MODEL = (process.env.AI_SUGGESTIONS_MODEL ?? '').trim();

/**
 * Check if AI feature is available (org/plan/config allows it).
 * Does not consider user-level ai_suggestions_enabled.
 * When OPENAI_API_KEY is set, returns tenant's ai_enabled from system_config; else checks ai_enabled + ai_api_key from system_config (tenant-scoped).
 */
export async function isAIFeatureAvailable(userId: string, tenantId: string): Promise<boolean> {
  if (ENV_API_KEY) {
    const aiEnabled = await queryOne(
      'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
      ['ai_enabled', tenantId]
    );
    return !!(aiEnabled && (aiEnabled as any).value === 'true');
  }
  const aiEnabled = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_enabled', tenantId]
  );
  if (!aiEnabled || (aiEnabled as any).value !== 'true') return false;
  const aiApiKey = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_api_key', tenantId]
  );
  return !!(aiApiKey && (aiApiKey as any).value);
}

/**
 * Check if AI suggestions are enabled for the user.
 * Returns false if not configured or user opted out.
 */
export async function isAISuggestionsEnabled(userId: string, tenantId: string): Promise<boolean> {
  const userRow = await queryOne(
    'SELECT ai_suggestions_enabled FROM users WHERE id = ?',
    [userId]
  );
  const userEnabled = userRow
    ? (userRow as any).ai_suggestions_enabled !== 0 && (userRow as any).ai_suggestions_enabled !== false
    : true;

  if (!userEnabled) return false;

  if (ENV_API_KEY) {
    const aiEnabled = await queryOne(
      'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
      ['ai_enabled', tenantId]
    );
    return !!(aiEnabled && (aiEnabled as any).value === 'true');
  }

  const aiEnabled = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_enabled', tenantId]
  );
  if (!aiEnabled || (aiEnabled as any).value !== 'true') return false;

  const aiApiKey = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_api_key', tenantId]
  );
  if (!aiApiKey || !(aiApiKey as any).value) return false;

  return true;
}

/**
 * Get AI API key for making requests.
 * When OPENAI_API_KEY env is set, returns it; else reads from system_config (tenant-scoped) and decrypts when needed.
 */
export async function getAIApiKey(tenantId: string): Promise<string | null> {
  if (ENV_API_KEY) return ENV_API_KEY;
  const row = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_api_key', tenantId]
  );
  if (!row || !(row as any).value) return null;
  const raw = (row as any).value as string;
  if (raw.startsWith('sk-') && !raw.includes(':')) {
    return raw;
  }
  try {
    const { decrypt } = await import('./encryption.js');
    return decrypt(raw);
  } catch {
    return raw;
  }
}

/**
 * Get AI model from config. When AI_SUGGESTIONS_MODEL env is set, returns it; else reads from system_config (tenant-scoped). Default gpt-4o-mini.
 */
export async function getAIModel(tenantId: string): Promise<string> {
  if (ENV_MODEL) return ENV_MODEL;
  const row = await queryOne(
    'SELECT value FROM system_config WHERE key = ? AND tenant_id = ?',
    ['ai_model', tenantId]
  );
  return (row && (row as any).value) ? String((row as any).value) : 'gpt-4o-mini';
}
