import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { encrypt, decrypt } from '../utils/encryption.js';
import { reloadOIDCStrategies } from '../auth/oidc.js';
import { isCloud } from '../config/mode.js';
import { validateOidcUrl, validateProviderKey } from '../utils/validation.js';

const router = Router();
// CLOUD mode: do not expose "bring your own" OIDC; fixed providers only via env
router.use((req, res, next) => {
  if (isCloud) return res.status(403).json({ error: 'OIDC provider management is not available in CLOUD mode' });
  next();
});
router.use(requireAuth());
router.use(requireAdmin());

/**
 * @swagger
 * /api/oidc-providers:
 *   get:
 *     summary: Get all OIDC providers
 *     description: Returns all configured OIDC providers (without client secrets). Admin only.
 *     tags: [Admin - OIDC Providers]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of OIDC providers
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   provider_key:
 *                     type: string
 *                     example: "google"
 *                   issuer_url:
 *                     type: string
 *                     example: "https://accounts.google.com"
 *                   scopes:
 *                     type: string
 *                     example: "openid profile email"
 *                   auto_create_users:
 *                     type: boolean
 *                   default_role:
 *                     type: string
 *                     enum: [user, admin]
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
// Get all OIDC providers (without secrets)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const providers = await query('SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers ORDER BY created_at DESC', []);
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

/**
 * @swagger
 * /api/oidc-providers/{id}:
 *   get:
 *     summary: Get OIDC provider by ID
 *     description: Returns a single OIDC provider (without client secret). Admin only.
 *     tags: [Admin - OIDC Providers]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Provider details
 *       404:
 *         description: Provider not found
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
// Get single OIDC provider (without secret)
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const provider = await queryOne(
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ?',
      [id]
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

/**
 * @swagger
 * /api/oidc-providers:
 *   post:
 *     summary: Create OIDC provider
 *     description: Creates a new OIDC provider. Client secret is encrypted before storage. Admin only.
 *     tags: [Admin - OIDC Providers]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - provider_key
 *               - client_id
 *               - client_secret
 *               - issuer_url
 *             properties:
 *               provider_key:
 *                 type: string
 *                 example: "google"
 *                 description: Unique identifier for the provider
 *               client_id:
 *                 type: string
 *                 example: "123456789.apps.googleusercontent.com"
 *               client_secret:
 *                 type: string
 *                 example: "GOCSPX-secret-key"
 *                 description: Will be encrypted before storage
 *               issuer_url:
 *                 type: string
 *                 format: uri
 *                 example: "https://accounts.google.com"
 *               scopes:
 *                 type: string
 *                 default: "openid profile email"
 *                 example: "openid profile email"
 *               auto_create_users:
 *                 type: boolean
 *                 default: true
 *                 description: Automatically create users on first OIDC login
 *               default_role:
 *                 type: string
 *                 enum: [user, admin]
 *                 default: "user"
 *                 description: Default role for auto-created users
 *     responses:
 *       201:
 *         description: Provider created successfully
 *       400:
 *         description: Missing required fields, invalid default_role, or provider_key already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
// Create OIDC provider
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
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

    // Validate OIDC URLs (SSRF prevention)
    const issuerValidation = validateOidcUrl(issuer_url);
    if (!issuerValidation.valid) {
      return res.status(400).json({ error: `issuer_url: ${issuerValidation.error}` });
    }
    if (authorization_url) {
      const authUrlValidation = validateOidcUrl(authorization_url);
      if (!authUrlValidation.valid) {
        return res.status(400).json({ error: `authorization_url: ${authUrlValidation.error}` });
      }
    }
    if (token_url) {
      const tokenUrlValidation = validateOidcUrl(token_url);
      if (!tokenUrlValidation.valid) {
        return res.status(400).json({ error: `token_url: ${tokenUrlValidation.error}` });
      }
    }
    if (userinfo_url) {
      const userinfoUrlValidation = validateOidcUrl(userinfo_url);
      if (!userinfoUrlValidation.valid) {
        return res.status(400).json({ error: `userinfo_url: ${userinfoUrlValidation.error}` });
      }
    }

    // Validate default_role
    if (default_role !== 'user' && default_role !== 'admin') {
      return res.status(400).json({ error: 'default_role must be "user" or "admin"' });
    }

    // Check if provider_key already exists
    const existing = await queryOne('SELECT id FROM oidc_providers WHERE provider_key = ?', [provider_key]);
    if (existing) {
      return res.status(400).json({ error: 'Provider with this key already exists' });
    }

    // Encrypt client_secret before storing
    const encryptedSecret = encrypt(client_secret);

    const providerId = uuidv4();
    await execute(
      `INSERT INTO oidc_providers (id, provider_key, client_id, client_secret, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        providerId,
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
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ?',
      [providerId]
    );
    
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

/**
 * @swagger
 * /api/oidc-providers/{id}:
 *   put:
 *     summary: Update OIDC provider
 *     description: Updates an existing OIDC provider. If client_secret is provided, it will be encrypted. Admin only.
 *     tags: [Admin - OIDC Providers]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider_key:
 *                 type: string
 *               client_id:
 *                 type: string
 *               client_secret:
 *                 type: string
 *                 description: Will be encrypted if provided
 *               issuer_url:
 *                 type: string
 *               scopes:
 *                 type: string
 *               auto_create_users:
 *                 type: boolean
 *               default_role:
 *                 type: string
 *                 enum: [user, admin]
 *     responses:
 *       200:
 *         description: Provider updated successfully
 *       400:
 *         description: Invalid default_role or provider_key already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Provider not found
 */
// Update OIDC provider
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
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

    const existing = await queryOne('SELECT * FROM oidc_providers WHERE id = ?', [id]);
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

    // Validate OIDC URLs if provided (SSRF prevention)
    if (issuer_url) {
      const issuerValidation = validateOidcUrl(issuer_url);
      if (!issuerValidation.valid) {
        return res.status(400).json({ error: `issuer_url: ${issuerValidation.error}` });
      }
    }
    if (authorization_url !== undefined) {
      const urlToValidate = authorization_url || '';
      if (urlToValidate) {
        const authUrlValidation = validateOidcUrl(urlToValidate);
        if (!authUrlValidation.valid) {
          return res.status(400).json({ error: `authorization_url: ${authUrlValidation.error}` });
        }
      }
    }
    if (token_url !== undefined) {
      const urlToValidate = token_url || '';
      if (urlToValidate) {
        const tokenUrlValidation = validateOidcUrl(urlToValidate);
        if (!tokenUrlValidation.valid) {
          return res.status(400).json({ error: `token_url: ${tokenUrlValidation.error}` });
        }
      }
    }
    if (userinfo_url !== undefined) {
      const urlToValidate = userinfo_url || '';
      if (urlToValidate) {
        const userinfoUrlValidation = validateOidcUrl(urlToValidate);
        if (!userinfoUrlValidation.valid) {
          return res.status(400).json({ error: `userinfo_url: ${userinfoUrlValidation.error}` });
        }
      }
    }

    // Check provider_key uniqueness if changed
    if (provider_key && provider_key !== (existing as any).provider_key) {
      const keyExists = await queryOne('SELECT id FROM oidc_providers WHERE provider_key = ? AND id != ?', [provider_key, id]);
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

    params.push(id);
    await execute(
      `UPDATE oidc_providers SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    // Reload OIDC strategies
    await reloadOIDCStrategies();

    const provider = await queryOne(
      'SELECT id, provider_key, issuer_url, authorization_url, token_url, userinfo_url, scopes, auto_create_users, default_role, created_at FROM oidc_providers WHERE id = ?',
      [id]
    );
    
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

/**
 * @swagger
 * /api/oidc-providers/{id}:
 *   delete:
 *     summary: Delete OIDC provider
 *     description: Deletes an OIDC provider. Admin only.
 *     tags: [Admin - OIDC Providers]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Provider ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Provider deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Provider deleted"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Provider not found
 */
// Delete OIDC provider
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;

    const provider = await queryOne('SELECT * FROM oidc_providers WHERE id = ?', [id]);
    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    await execute('DELETE FROM oidc_providers WHERE id = ?', [id]);

    // Reload OIDC strategies
    await reloadOIDCStrategies();

    res.json({ message: 'Provider deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
