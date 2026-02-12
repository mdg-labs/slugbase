import { Router } from 'express';
import { query, queryOne, execute } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { testSMTPConfig } from '../../utils/email.js';
import { encrypt } from '../../utils/encryption.js';
import { isCloud } from '../../config/mode.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

/**
 * @swagger
 * /api/admin/settings:
 *   get:
 *     summary: Get all system settings
 *     description: Returns all system configuration settings as a key-value object. Admin only.
 *     tags: [Admin - Settings]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: string
 *               example:
 *                 setting1: "value1"
 *                 setting2: "value2"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const settings = await query('SELECT * FROM system_config ORDER BY key', []);
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

/**
 * @swagger
 * /api/admin/settings/{key}:
 *   get:
 *     summary: Get setting by key
 *     description: Returns a specific system setting by its key. Admin only.
 *     tags: [Admin - Settings]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *         description: Setting key
 *         example: "app_name"
 *     responses:
 *       200:
 *         description: Setting value
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 key:
 *                   type: string
 *                   example: "app_name"
 *                 value:
 *                   type: string
 *                   example: "SlugBase"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Setting not found
 */
router.get('/:key', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { key } = req.params;
    const setting = await queryOne('SELECT * FROM system_config WHERE key = ?', [key]);
    if (!setting) {
      return res.status(404).json({ error: 'Setting not found' });
    }
    res.json({ key: (setting as any).key, value: (setting as any).value });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/settings:
 *   post:
 *     summary: Set system setting
 *     description: Creates or updates a system setting. If the key exists, it will be updated. Admin only.
 *     tags: [Admin - Settings]
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
 *               - key
 *               - value
 *             properties:
 *               key:
 *                 type: string
 *                 example: "app_name"
 *                 description: Setting key (unique identifier)
 *               value:
 *                 type: string
 *                 example: "SlugBase"
 *                 description: Setting value (will be stored as string)
 *     responses:
 *       200:
 *         description: Setting saved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 key:
 *                   type: string
 *                 value:
 *                   type: string
 *       400:
 *         description: Missing key or value
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({ error: 'Key and value are required' });
    }

    await execute(
      'INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)',
      [key, String(value)]
    );

    const setting = await queryOne('SELECT * FROM system_config WHERE key = ?', [key]);
    res.json({ key: (setting as any).key, value: (setting as any).value });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/settings/{key}:
 *   delete:
 *     summary: Delete system setting
 *     description: Deletes a system setting by its key. Admin only.
 *     tags: [Admin - Settings]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *         description: Setting key to delete
 *         example: "app_name"
 *     responses:
 *       200:
 *         description: Setting deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Setting deleted"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.delete('/:key', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { key } = req.params;
    await execute('DELETE FROM system_config WHERE key = ?', [key]);
    res.json({ message: 'Setting deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/settings/smtp/test:
 *   post:
 *     summary: Test SMTP configuration
 *     description: Sends a test email to verify SMTP settings are working. Admin only.
 *     tags: [Admin - Settings]
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
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "test@example.com"
 *     responses:
 *       200:
 *         description: Test email sent successfully
 *       400:
 *         description: SMTP not configured or test failed
 */
router.post('/smtp/test', async (req, res) => {
  const authReq = req as AuthRequest;

  if (isCloud) {
    return res.status(403).json({ error: 'SMTP configuration is managed via environment variables in CLOUD mode' });
  }
  
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

/**
 * @swagger
 * /api/admin/settings/smtp:
 *   post:
 *     summary: Update SMTP settings
 *     description: Updates SMTP configuration. Password is encrypted before storage. Admin only.
 *     tags: [Admin - Settings]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 example: true
 *               host:
 *                 type: string
 *                 example: "smtp.gmail.com"
 *               port:
 *                 type: number
 *                 example: 587
 *               secure:
 *                 type: boolean
 *                 example: false
 *               user:
 *                 type: string
 *                 example: "your-email@gmail.com"
 *               password:
 *                 type: string
 *                 example: "your-password"
 *               from:
 *                 type: string
 *                 example: "noreply@example.com"
 *               fromName:
 *                 type: string
 *                 example: "SlugBase"
 *     responses:
 *       200:
 *         description: SMTP settings updated successfully
 */
router.post('/smtp', async (req, res) => {
  const authReq = req as AuthRequest;

  if (isCloud) {
    return res.status(403).json({ error: 'SMTP configuration is managed via environment variables in CLOUD mode' });
  }
  
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
      console.log('SMTP password saved (encrypted, length:', encryptedPassword.length, ')');
    } else if (password !== undefined) {
      // If password is explicitly set to empty string, don't save it
      // This allows updating other settings without changing the password
      console.log('SMTP password not updated (empty or unchanged)');
    }
    if (from !== undefined) {
      settings.push({ key: 'smtp_from', value: from });
    }
    if (fromName !== undefined) {
      settings.push({ key: 'smtp_from_name', value: fromName });
    }

    // Save all settings
    for (const setting of settings) {
      await execute(
        'INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)',
        [setting.key, setting.value]
      );
    }

    res.json({ message: 'SMTP settings updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
