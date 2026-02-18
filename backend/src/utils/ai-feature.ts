/**
 * AI suggestions feature flag logic.
 * Self-hosted: system_config (ai_enabled, ai_api_key) + user.ai_suggestions_enabled
 * Cloud: org.ai_enabled + plan in [personal, team] + user.ai_suggestions_enabled
 */

import { queryOne } from '../db/index.js';
import { isCloud } from '../config/mode.js';
import { getCurrentOrgId, getUserPlan } from './organizations.js';

/**
 * Check if AI feature is available (org/plan/config allows it).
 * Does not consider user-level ai_suggestions_enabled.
 */
export async function isAIFeatureAvailable(userId: string): Promise<boolean> {
  if (isCloud) {
    const orgId = await getCurrentOrgId(userId);
    if (!orgId) return false;
    const orgRow = await queryOne(
      'SELECT ai_enabled FROM organizations WHERE id = ?',
      [orgId]
    );
    const orgEnabled = orgRow
      ? (orgRow as any).ai_enabled === 1 || (orgRow as any).ai_enabled === true
      : false;
    if (!orgEnabled) return false;
    const plan = await getUserPlan(userId);
    if (plan !== 'personal' && plan !== 'team') return false;
    return true;
  }
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
 * Returns false if not configured, org disabled (Cloud), Free plan (Cloud), or user opted out.
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

  if (isCloud) {
    const orgId = await getCurrentOrgId(userId);
    if (!orgId) return false;

    const orgRow = await queryOne(
      'SELECT ai_enabled FROM organizations WHERE id = ?',
      [orgId]
    );
    const orgEnabled = orgRow
      ? (orgRow as any).ai_enabled === 1 || (orgRow as any).ai_enabled === true
      : false;

    if (!orgEnabled) return false;

    const plan = await getUserPlan(userId);
    if (plan !== 'personal' && plan !== 'team') return false;

    return true;
  }

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
 * Self-hosted: from system_config (decrypted)
 * Cloud: from AI_OPENAI_API_KEY env var
 */
export async function getAIApiKey(): Promise<string | null> {
  if (isCloud) {
    return process.env.AI_OPENAI_API_KEY || null;
  }
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
  if (isCloud) {
    return process.env.AI_OPENAI_MODEL || 'gpt-4o-mini';
  }
  const row = await queryOne(
    'SELECT value FROM system_config WHERE key = ?',
    ['ai_model']
  );
  return (row && (row as any).value) ? String((row as any).value) : 'gpt-4o-mini';
}
