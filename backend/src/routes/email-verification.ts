import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { validateEmail, normalizeEmail } from '../utils/validation.js';
import { sendEmailVerificationEmail } from '../utils/email.js';
import { authRateLimiter } from '../middleware/security.js';

const router = Router();

router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ valid: false, error: 'Token is required' });
    }

    // Find token
    const verificationToken = await queryOne(
      'SELECT * FROM email_verification_tokens WHERE token = ? AND used = FALSE',
      [token]
    );

    if (!verificationToken) {
      return res.status(400).json({ valid: false, error: 'Invalid or expired token' });
    }

    // Check expiration
    const expiresAt = new Date((verificationToken as any).expires_at);
    if (expiresAt < new Date()) {
      // Mark as used
      await execute('UPDATE email_verification_tokens SET used = TRUE WHERE token = ?', [token]);
      return res.status(400).json({ valid: false, error: 'Token has expired' });
    }

    res.json({ valid: true, newEmail: (verificationToken as any).new_email });
  } catch (error: any) {
    console.error('Token verification error:', error);
    res.status(400).json({ valid: false, error: 'Invalid token' });
  }
});

router.post('/confirm', authRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // Find token
    const verificationToken = await queryOne(
      'SELECT * FROM email_verification_tokens WHERE token = ? AND used = FALSE',
      [token]
    );

    if (!verificationToken) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Check expiration
    const expiresAt = new Date((verificationToken as any).expires_at);
    if (expiresAt < new Date()) {
      // Mark as used
      await execute('UPDATE email_verification_tokens SET used = TRUE WHERE token = ?', [token]);
      return res.status(400).json({ error: 'Token has expired' });
    }

    const userId = (verificationToken as any).user_id;
    const newEmail = (verificationToken as any).new_email;
    const normalizedNewEmail = normalizeEmail(newEmail);

    // Check if new email is already in use by another user
    const emailExists = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedNewEmail, userId]);
    if (emailExists) {
      return res.status(400).json({ error: 'This email address is already in use' });
    }

    // Update user email and clear pending email
    await execute('UPDATE users SET email = ?, email_pending = NULL WHERE id = ?', [normalizedNewEmail, userId]);

    // Mark token as used
    await execute('UPDATE email_verification_tokens SET used = TRUE WHERE token = ?', [token]);

    // Invalidate all other verification tokens for this user
    await execute(
      'UPDATE email_verification_tokens SET used = TRUE WHERE user_id = ? AND used = FALSE',
      [userId]
    );

    res.json({ message: 'Email verified and updated successfully', email: normalizedNewEmail });
  } catch (error: any) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

export default router;
