import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { validateEmail, normalizeEmail, validateLength, sanitizeString } from '../utils/validation.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { sendEmailVerificationEmail } from '../utils/email.js';
import { getClearAuthCookieOptions } from '../config/cookies.js';
import { isCloud } from '../config/mode.js';
import { recordAuditEvent } from '../services/audit-log.js';

const router = Router();
router.use(requireAuth());

// List users for sharing (same tenant/org). No admin required. Used by sharing modal.
// Core: users table has no tenant_id; returns all users except current (self-hosted single-tenant).
router.get('/for-sharing', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const rows = await query(
      'SELECT id, name, email FROM users WHERE id != ? ORDER BY name ASC, email ASC',
      [userId]
    );
    const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
    res.json(list);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
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

        await recordAuditEvent(req, {
          action: 'user.email_change_requested',
          entityType: 'user',
          entityId: userId,
          metadata: { pending_email: normalizedEmail },
        });

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
      if (isCloud && (req as any).plan === 'free') {
        return res.status(403).json({ error: 'AI suggestions are not available on the free plan.' });
      }
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

    const fieldsUpdated: string[] = [];
    if (name !== undefined) fieldsUpdated.push('name');
    if (language !== undefined) fieldsUpdated.push('language');
    if (theme !== undefined) fieldsUpdated.push('theme');
    if (ai_suggestions_enabled !== undefined) fieldsUpdated.push('ai_suggestions_enabled');
    if (fieldsUpdated.length > 0) {
      await recordAuditEvent(req, {
        action: 'user.profile_updated',
        entityType: 'user',
        entityId: userId,
        metadata: { fields: fieldsUpdated },
      });
    }

    const user = await queryOne('SELECT id, email, name, user_key, is_admin, language, theme, ai_suggestions_enabled FROM users WHERE id = ?', [userId]);
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete current user account. Cascades via DB FKs (api_tokens, team_members, etc.).
// Clears auth cookie so client is logged out.
router.delete('/me', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const user = await queryOne('SELECT id, email FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await recordAuditEvent(req, {
      action: 'user.self_deleted',
      entityType: 'user',
      entityId: userId,
      metadata: { email: (user as { email?: string }).email },
    });
    await execute('DELETE FROM users WHERE id = ?', [userId]);
    const clearOpts = getClearAuthCookieOptions();
    res.clearCookie('token', clearOpts);
    res.json({ message: 'Account deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
