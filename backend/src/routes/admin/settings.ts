import { Router, type Request, type Response, type NextFunction } from 'express';
import { query, queryOne, execute, upsertSystemConfig } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { testSMTPConfig } from '../../utils/email.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { getTenantId } from '../../utils/tenant.js';
import { listOpenAIModels } from '../../services/ai-suggestions.js';
import { isCloud } from '../../config/mode.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

function rejectCloudFreePlanAi(req: Request, res: Response, next: NextFunction) {
  if (isCloud && (req as any).plan === 'free') {
    return res.status(403).json({ error: 'AI suggestions are not available on the free plan.' });
  }
  next();
}

router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const settings = await query('SELECT * FROM system_config WHERE tenant_id = ? ORDER BY key', [tenantId]);
    const settingsList = Array.isArray(settings) ? settings : (settings ? [settings] : []);
    
    // Convert array to object
    const settingsObj: Record<string, string> = {};
    settingsList.forEach((setting: any) => {
      // Don't expose the actual password value, just indicate if it's set
      if (setting.key === 'smtp_password') {
        settingsObj[setting.key] = setting.value ? '***SET***' : '';
      } else {
        settingsObj[setting.key] = setting.value;
      }
    });
    
    res.json(settingsObj);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ai', rejectCloudFreePlanAi, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const keys = ['ai_enabled', 'ai_provider', 'ai_api_key', 'ai_model'];
    const result: Record<string, string> = {};
    for (const key of keys) {
      const row = await queryOne('SELECT value FROM system_config WHERE key = ? AND tenant_id = ?', [key, tenantId]);
      const val = row ? (row as any).value : '';
      result[key] = key === 'ai_api_key' && val ? '***SET***' : (val || '');
    }
    res.json({
      ai_enabled: result.ai_enabled === 'true',
      ai_provider: result.ai_provider || 'openai',
      ai_model: result.ai_model || 'gpt-4o-mini',
      ai_api_key_set: result.ai_api_key === '***SET***',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** GET /admin/settings/smtp - SMTP keys only (for Settings page; no ai_* or other keys). */
router.get('/smtp', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const smtpKeys = ['smtp_enabled', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from', 'smtp_from_name'];
    const settingsObj: Record<string, string> = {};
    for (const key of smtpKeys) {
      const row = await queryOne('SELECT value FROM system_config WHERE key = ? AND tenant_id = ?', [key, tenantId]);
      const val = row ? (row as any).value : '';
      settingsObj[key] = key === 'smtp_password' && val ? '***SET***' : (val || '');
    }
    res.json(settingsObj);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/ai/models', rejectCloudFreePlanAi, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const providerRow = await queryOne('SELECT value FROM system_config WHERE key = ? AND tenant_id = ?', ['ai_provider', tenantId]);
    const keyRow = await queryOne('SELECT value FROM system_config WHERE key = ? AND tenant_id = ?', ['ai_api_key', tenantId]);
    const provider = (providerRow && (providerRow as { value?: string }).value) ? String((providerRow as { value: string }).value) : 'openai';
    const rawKey = (keyRow && (keyRow as { value?: string }).value) ? (keyRow as { value: string }).value : '';
    if (!rawKey || rawKey.trim() === '') {
      return res.status(400).json({ error: 'API key required to list models. Set and save your API key first.' });
    }
    let apiKey: string;
    try {
      apiKey = decrypt(rawKey);
    } catch {
      return res.status(400).json({ error: 'Could not read API key. Save it again and retry.' });
    }
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: 'API key required to list models. Set and save your API key first.' });
    }
    if (provider === 'openai') {
      const models = await listOpenAIModels(apiKey.trim());
      return res.json({ models });
    }
    return res.json({ models: [] });
  } catch (error: unknown) {
    const err = error as { message?: string };
    res.status(500).json({ error: err?.message ?? 'Failed to list models' });
  }
});

router.get('/:key', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const { key } = req.params;
    const setting = await queryOne('SELECT * FROM system_config WHERE key = ? AND tenant_id = ?', [key, tenantId]);
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ key: (setting as any).key, value: (setting as any).value });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    await upsertSystemConfig(tenantId, key, String(value));

    const setting = await queryOne('SELECT * FROM system_config WHERE key = ? AND tenant_id = ?', [key, tenantId]);
    res.json({ key: (setting as any).key, value: (setting as any).value });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:key', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const tenantId = getTenantId(req);
    const { key } = req.params;
    await execute('DELETE FROM system_config WHERE key = ? AND tenant_id = ?', [key, tenantId]);
    res.json({ message: 'Setting deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/smtp/test', async (req, res) => {
  const authReq = req as AuthRequest;
  
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await testSMTPConfig(email);
    if (result.success) {
      res.json({ message: 'Test email sent successfully' });
    } else {
      res.status(400).json({ error: result.error || 'Failed to send test email' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/smtp', async (req, res) => {
  const authReq = req as AuthRequest;
  const tenantId = getTenantId(req);
  
  try {
    const { enabled, host, port, secure, user, password, from, fromName } = req.body;

    const settings: Array<{ key: string; value: string }> = [];

    if (enabled !== undefined) {
      settings.push({ key: 'smtp_enabled', value: enabled ? 'true' : 'false' });
    }
    if (host !== undefined) {
      settings.push({ key: 'smtp_host', value: host });
    }
    if (port !== undefined) {
      settings.push({ key: 'smtp_port', value: String(port) });
    }
    if (secure !== undefined) {
      settings.push({ key: 'smtp_secure', value: secure ? 'true' : 'false' });
    }
    if (user !== undefined) {
      settings.push({ key: 'smtp_user', value: user });
    }
    if (password !== undefined && password !== null && password.trim() !== '') {
      // Only save password if it's not empty
      // Encrypt password before storage
      const encryptedPassword = encrypt(password.trim());
      settings.push({ key: 'smtp_password', value: encryptedPassword });
      console.log('SMTP credential saved (encrypted)');
    } else if (password !== undefined) {
      // If password is explicitly set to empty string, don't save it
      // This allows updating other settings without changing the password
      console.log('SMTP credential not updated (empty or unchanged)');
    }
    if (from !== undefined) {
      settings.push({ key: 'smtp_from', value: from });
    }
    if (fromName !== undefined) {
      settings.push({ key: 'smtp_from_name', value: fromName });
    }

    // Save all settings
    for (const setting of settings) {
      await upsertSystemConfig(tenantId, setting.key, setting.value);
    }

    res.json({ message: 'SMTP settings updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ai', rejectCloudFreePlanAi, async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { ai_enabled, ai_provider, ai_api_key, ai_model } = req.body;

    if (ai_enabled !== undefined) {
      await upsertSystemConfig(tenantId, 'ai_enabled', ai_enabled ? 'true' : 'false');
    }
    if (ai_provider !== undefined) {
      await upsertSystemConfig(tenantId, 'ai_provider', String(ai_provider));
    }
    if (ai_api_key !== undefined && ai_api_key !== null && ai_api_key.trim() !== '') {
      const encrypted = encrypt(ai_api_key.trim());
      await upsertSystemConfig(tenantId, 'ai_api_key', encrypted);
    }
    if (ai_model !== undefined) {
      await upsertSystemConfig(tenantId, 'ai_model', String(ai_model));
    }

    res.json({ message: 'AI settings updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
