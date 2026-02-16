import { Router } from 'express';
import { queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { validateEmail, normalizeEmail, validateLength, sanitizeString } from '../utils/validation.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sendEmailVerificationEmail } from '../utils/email.js';
import { setCurrentOrg } from '../utils/organizations.js';
import { isCloud } from '../config/mode.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     summary: Get current user profile
 *     description: Returns the authenticated user's profile information
 *     tags: [Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 email:
 *                   type: string
 *                 name:
 *                   type: string
 *                 user_key:
 *                   type: string
 *                 is_admin:
 *                   type: boolean
 *                 language:
 *                   type: string
 *                   example: "en"
 *                 theme:
 *                   type: string
 *                   example: "auto"
 *       401:
 *         description: Unauthorized
 */
/**
 * @swagger
 * /api/users/me/current-org:
 *   put:
 *     summary: Switch current organization
 *     description: Switches the user's current organization context. Cloud mode only. Alias for PUT /api/organizations/me/switch.
 *     tags: [Users]
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
 *               - org_id
 *             properties:
 *               org_id:
 *                 type: string
 *     responses:
 *       200:
 *         description: Organization switched
 *       400:
 *         description: org_id is required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a member of this organization
 *       404:
 *         description: Not found (self-hosted mode)
 */
router.put('/me/current-org', async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const { org_id } = req.body;
  if (!org_id || typeof org_id !== 'string') {
    return res.status(400).json({ error: 'org_id is required' });
  }
  const ok = await setCurrentOrg(userId, org_id);
  if (!ok) {
    return res.status(403).json({ error: 'You are not a member of this organization' });
  }
  res.json({ message: 'Organization switched', org_id });
});

// Get current user profile
router.get('/me', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const user = await queryOne('SELECT id, email, name, user_key, is_admin, language, theme, ai_suggestions_enabled, email_pending, oidc_provider, oidc_sub FROM users WHERE id = ?', [userId]);
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/users/me:
 *   put:
 *     summary: Update user settings
 *     description: Updates the authenticated user's profile information including email, name, language, and theme preferences
 *     tags: [Users]
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
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "updated@example.com"
 *                 description: User's email address (must be unique)
 *               name:
 *                 type: string
 *                 example: "Updated Name"
 *                 description: User's display name
 *               language:
 *                 type: string
 *                 enum: [en, de, fr]
 *                 example: "en"
 *                 description: User's preferred language
 *               theme:
 *                 type: string
 *                 enum: [light, dark, auto]
 *                 example: "auto"
 *                 description: User's preferred theme
 *     responses:
 *       200:
 *         description: User settings updated successfully
 *       400:
 *         description: Invalid input or email already exists
 *       401:
 *         description: Unauthorized
 */
// Update user settings
router.put('/me', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const { email, name, language, theme, ai_suggestions_enabled } = req.body;

    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates: string[] = [];
    const params: any[] = [];

    // Validate and update email if provided
    if (email !== undefined) {
      // Check if user is connected to OIDC provider - email cannot be changed for OIDC users
      if ((existing as any).oidc_provider) {
        return res.status(400).json({ error: 'Email cannot be changed for OIDC-authenticated users. Email is managed by your identity provider.' });
      }
      
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }
      const normalizedEmail = normalizeEmail(email);
      
      // Check if email is actually changing
      if (normalizedEmail !== (existing as any).email) {
        // Check if new email is already in use
        const emailExists = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, userId]);
        if (emailExists) {
          return res.status(400).json({ error: 'User with this email already exists' });
        }

        // Check if there's already a pending email verification
        const pendingEmail = (existing as any).email_pending;
        if (pendingEmail && pendingEmail !== normalizedEmail) {
          // Cancel previous verification tokens
          await execute(
            'UPDATE email_verification_tokens SET used = TRUE WHERE user_id = ? AND used = FALSE',
            [userId]
          );
        }

        // Generate verification token
        const token = crypto.randomBytes(32).toString('hex');
        const tokenId = uuidv4();
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours expiration

        // Store token in database
        await execute(
          'INSERT INTO email_verification_tokens (id, user_id, token, new_email, expires_at) VALUES (?, ?, ?, ?, ?)',
          [tokenId, userId, token, normalizedEmail, expiresAt.toISOString()]
        );

        // Set pending email (don't update actual email yet)
        await execute('UPDATE users SET email_pending = ? WHERE id = ?', [normalizedEmail, userId]);

        // Build verification URL
        const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const verificationUrl = `${baseUrl}/verify-email?token=${token}`;

        // Send verification email to the NEW email address
        await sendEmailVerificationEmail(normalizedEmail, token, verificationUrl, normalizedEmail);

        // Return success but indicate email verification is required
        return res.json({
          message: 'Email change requested. Please check your new email address for a verification link.',
          emailVerificationRequired: true,
          currentEmail: (existing as any).email,
          pendingEmail: normalizedEmail,
        });
      }
      // If email hasn't changed, no action needed
    }

    // Validate and update name if provided
    if (name !== undefined) {
      const nameValidation = validateLength(name, 'Name', 1, 255);
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
      updates.push('name = ?');
      params.push(sanitizeString(name));
    }

    if (language !== undefined) {
      updates.push('language = ?');
      params.push(language);
    }
    if (theme !== undefined) {
      updates.push('theme = ?');
      params.push(theme);
    }

    if (ai_suggestions_enabled !== undefined) {
      const DB_TYPE = process.env.DB_TYPE || 'sqlite';
      const val = ai_suggestions_enabled === true || ai_suggestions_enabled === 'true';
      updates.push('ai_suggestions_enabled = ?');
      params.push(DB_TYPE === 'postgresql' ? val : (val ? 1 : 0));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(userId);
    await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const user = await queryOne('SELECT id, email, name, user_key, is_admin, language, theme, ai_suggestions_enabled FROM users WHERE id = ?', [userId]);
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
