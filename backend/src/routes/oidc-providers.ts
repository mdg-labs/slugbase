import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { encrypt } from '../utils/encryption.js';
import { reloadOIDCStrategies } from '../auth/oidc.js';
import { validateOidcUrlAsync, validateProviderKey } from '../utils/validation.js';
import { getTenantId } from '../utils/tenant.js';
import { recordAuditEvent } from '../services/audit-log.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

// Get all OIDC providers (without secrets)
router.get('/', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const providers = await query('SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
    const providersList = Array.isArray(providers) ? providers : (providers ? [providers] : []);
    
    // Add callback URL information for each provider to help with OIDC configuration
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const providersWithCallback = providersList.map((p: any) => ({
      ...p,
      callback_url: `${baseUrl}/api/auth/${p.provider_key}/callback`,
    }));
    
    res.json(providersWithCallback);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get single OIDC provider (without secret)
router.get('/:id', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const provider = await queryOne(
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }
    
    // Add callback URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const providerWithCallback = {
      ...provider,
      callback_url: `${baseUrl}/api/auth/${(provider as any).provider_key}/callback`,
    };
    
    res.json(providerWithCallback);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create OIDC provider
router.post('/', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const {
      provider_key,
      client_id,
      client_secret,
      issuer_url,
      authorization_url,
      token_url,
      userinfo_url,
      scopes = 'openid profile email',
      auto_create_users = true,
      default_role = 'user'
    } = req.body;

    if (!provider_key || !client_id || !client_secret || !issuer_url) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate provider_key format
    const providerKeyValidation = validateProviderKey(provider_key);
    if (!providerKeyValidation.valid) {
      return res.status(400).json({ error: providerKeyValidation.error });
    }

    // Validate OIDC URLs (SSRF + DNS rebind prevention)
    const issuerValidation = await validateOidcUrlAsync(issuer_url);
    if (!issuerValidation.valid) {
      return res.status(400).json({ error: `issuer_url: ${issuerValidation.error}` });
    }
    if (authorization_url) {
      const authUrlValidation = await validateOidcUrlAsync(authorization_url);
      if (!authUrlValidation.valid) {
        return res.status(400).json({ error: `authorization_url: ${authUrlValidation.error}` });
      }
    }
    if (token_url) {
      const tokenUrlValidation = await validateOidcUrlAsync(token_url);
      if (!tokenUrlValidation.valid) {
        return res.status(400).json({ error: `token_url: ${tokenUrlValidation.error}` });
      }
    }
    if (userinfo_url) {
      const userinfoUrlValidation = await validateOidcUrlAsync(userinfo_url);
      if (!userinfoUrlValidation.valid) {
        return res.status(400).json({ error: `userinfo_url: ${userinfoUrlValidation.error}` });
      }
    }

    // Validate default_role
    if (default_role !== 'user' && default_role !== 'admin') {
      return res.status(400).json({ error: 'default_role must be "user" or "admin"' });
    }

    // Check if provider_key already exists
    const existing = await queryOne('SELECT id FROM oidc_providers WHERE provider_key = ? AND tenant_id = ?', [provider_key, tenantId]);
    if (existing) {
      return res.status(400).json({ error: 'Provider with this key already exists' });
    }

    // Encrypt client_secret before storing
    const encryptedSecret = encrypt(client_secret);

    const providerId = uuidv4();
    await execute(
      `INSERT INTO oidc_providers (id, tenant_id, provider_key, client_id, client_secret, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        providerId,
        tenantId,
        provider_key,
        client_id,
        encryptedSecret,
        issuer_url,
        authorization_url || null,
        token_url || null,
        userinfo_url || null,
        scopes,
        auto_create_users ? 1 : 0,
        default_role
      ]
    );

    // Reload OIDC strategies
    await reloadOIDCStrategies();

    const provider = await queryOne(
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ? AND tenant_id = ?',
      [providerId, tenantId]
    );

    await recordAuditEvent(req, {
      action: 'oidc_provider.created',
      entityType: 'oidc_provider',
      entityId: providerId,
      metadata: { provider_key },
    });

    // Add callback URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const providerWithCallback = {
      ...provider,
      callback_url: `${baseUrl}/api/auth/${(provider as any).provider_key}/callback`,
    };

    res.status(201).json(providerWithCallback);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update OIDC provider
router.put('/:id', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const {
      provider_key,
      client_id,
      client_secret,
      issuer_url,
      authorization_url,
      token_url,
      userinfo_url,
      scopes,
      auto_create_users,
      default_role
    } = req.body;

    const existing = await queryOne('SELECT * FROM oidc_providers WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!existing) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    // Validate default_role if provided
    if (default_role && default_role !== 'user' && default_role !== 'admin') {
      return res.status(400).json({ error: 'default_role must be "user" or "admin"' });
    }

    // Validate provider_key format if changed
    if (provider_key && provider_key !== (existing as any).provider_key) {
      const providerKeyValidation = validateProviderKey(provider_key);
      if (!providerKeyValidation.valid) {
        return res.status(400).json({ error: providerKeyValidation.error });
      }
    }

    // Validate OIDC URLs if provided (SSRF + DNS rebind prevention)
    if (issuer_url) {
      const issuerValidation = await validateOidcUrlAsync(issuer_url);
      if (!issuerValidation.valid) {
        return res.status(400).json({ error: `issuer_url: ${issuerValidation.error}` });
      }
    }
    if (authorization_url !== undefined) {
      const urlToValidate = authorization_url || '';
      if (urlToValidate) {
        const authUrlValidation = await validateOidcUrlAsync(urlToValidate);
        if (!authUrlValidation.valid) {
          return res.status(400).json({ error: `authorization_url: ${authUrlValidation.error}` });
        }
      }
    }
    if (token_url !== undefined) {
      const urlToValidate = token_url || '';
      if (urlToValidate) {
        const tokenUrlValidation = await validateOidcUrlAsync(urlToValidate);
        if (!tokenUrlValidation.valid) {
          return res.status(400).json({ error: `token_url: ${tokenUrlValidation.error}` });
        }
      }
    }
    if (userinfo_url !== undefined) {
      const urlToValidate = userinfo_url || '';
      if (urlToValidate) {
        const userinfoUrlValidation = await validateOidcUrlAsync(urlToValidate);
        if (!userinfoUrlValidation.valid) {
          return res.status(400).json({ error: `userinfo_url: ${userinfoUrlValidation.error}` });
        }
      }
    }

    // Check provider_key uniqueness if changed
    if (provider_key && provider_key !== (existing as any).provider_key) {
      const keyExists = await queryOne('SELECT id FROM oidc_providers WHERE provider_key = ? AND id != ? AND tenant_id = ?', [provider_key, id, tenantId]);
      if (keyExists) {
        return res.status(400).json({ error: 'Provider with this key already exists' });
      }
    }

    // Build update query
    const updates: string[] = [];
    const params: any[] = [];

    if (provider_key !== undefined) {
      updates.push('provider_key = ?');
      params.push(provider_key);
    }
    if (client_id !== undefined && client_id !== null && client_id.trim() !== '') {
      updates.push('client_id = ?');
      params.push(client_id.trim());
    }
    if (client_secret !== undefined && client_secret !== null && client_secret.trim() !== '') {
      // Encrypt new secret
      updates.push('client_secret = ?');
      params.push(encrypt(client_secret.trim()));
    }
    if (issuer_url !== undefined) {
      updates.push('issuer_url = ?');
      params.push(issuer_url);
    }
    if (authorization_url !== undefined) {
      updates.push('authorization_url = ?');
      params.push(authorization_url || null);
    }
    if (token_url !== undefined) {
      updates.push('token_url = ?');
      params.push(token_url || null);
    }
    if (userinfo_url !== undefined) {
      updates.push('userinfo_url = ?');
      params.push(userinfo_url || null);
    }
    if (scopes !== undefined) {
      updates.push('scopes = ?');
      params.push(scopes);
    }
    if (auto_create_users !== undefined) {
      updates.push('auto_create_users = ?');
      params.push(auto_create_users ? 1 : 0);
    }
    if (default_role !== undefined) {
      updates.push('default_role = ?');
      params.push(default_role);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id, tenantId);
    await execute(
      `UPDATE oidc_providers SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    // Reload OIDC strategies
    await reloadOIDCStrategies();

    const provider = await queryOne(
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    await recordAuditEvent(req, {
      action: 'oidc_provider.updated',
      entityType: 'oidc_provider',
      entityId: id,
      metadata: { provider_key: (provider as any)?.provider_key },
    });

    // Add callback URL
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const providerWithCallback = {
      ...provider,
      callback_url: `${baseUrl}/api/auth/${(provider as any).provider_key}/callback`,
    };

    res.json(providerWithCallback);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete OIDC provider
router.delete('/:id', async (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const provider = await queryOne('SELECT * FROM oidc_providers WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    const providerKey = (provider as any).provider_key as string;

    await execute('DELETE FROM oidc_providers WHERE id = ? AND tenant_id = ?', [id, tenantId]);

    // Reload OIDC strategies
    await reloadOIDCStrategies();

    await recordAuditEvent(req, {
      action: 'oidc_provider.deleted',
      entityType: 'oidc_provider',
      entityId: id,
      metadata: { provider_key: providerKey },
    });

    res.json({ message: 'Provider deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
