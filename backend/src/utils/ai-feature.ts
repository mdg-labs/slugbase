/**
 * AI suggestions feature flag logic for self-hosted runtime.
 */

import { queryOne } from '../db/index.js';

/**
 * Check if AI feature is available (org/plan/config allows it).
 * Does not consider user-level ai_suggestions_enabled.
 */
export async function isAIFeatureAvailable(userId: string): Promise<boolean> {
  const aiEnabled = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_enabled']
  );
  if (!aiEnabled || (aiEnabled as any).value !== 'true') return false;
  const aiApiKey = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_api_key']
  );
  return !!(aiApiKey && (aiApiKey as any).value);
}

/**
 * Check if AI suggestions are enabled for the user.
 * Returns false if not configured or user opted out.
 */
export async function isAISuggestionsEnabled(userId: string): Promise<boolean> {
  const userRow = await queryOne(
    'SELECT ai_suggestions_enabled FROM users WHERE id = ?',
    [userId]
  );
  const userEnabled = userRow
    ? (userRow as any).ai_suggestions_enabled !== 0 && (userRow as any).ai_suggestions_enabled !== false
    : true;

  if (!userEnabled) return false;

  const aiEnabled = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_enabled']
  );
  if (!aiEnabled || (aiEnabled as any).value !== 'true') return false;

  const aiApiKey = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_api_key']
  );
  if (!aiApiKey || !(aiApiKey as any).value) return false;

  return true;
}

/**
 * Get AI API key for making requests.
 * Reads from system_config and decrypts when needed.
 */
export async function getAIApiKey(): Promise<string | null> {
  const row = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_api_key']
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
 * Get AI model from config. Default gpt-4o-mini.
 */
export async function getAIModel(): Promise<string> {
  const row = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_model']
  );
  return (row && (row as any).value) ? String((row as any).value) : 'gpt-4o-mini';
}
