import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { validateEmail, normalizeEmail, validatePassword } from '../utils/validation.js';
import { sendPasswordResetEmail } from '../utils/email.js';
import { authRateLimiter } from '../middleware/security.js';

const router = Router();

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Convert ? placeholders to $1, $2 for PostgreSQL */
function toPg(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function sql(sqlStr: string, params: any[]): [string, any[]] {
  return DB_TYPE === 'postgresql' ? [toPg(sqlStr), params] : [sqlStr, params];
}

/** Single message for invalid/expired to avoid leaking which case (L3) */
const INVALID_OR_EXPIRED = 'Invalid or expired token';

/**
 * Find a reset token row by submitted token (hash-first, then legacy plaintext).
 * Returns the row and its id for marking used; null if not found.
 */
async function findResetTokenByToken(submittedToken: string): Promise<{ row: any; id: string } | null> {
  const tokenHash = hashToken(submittedToken);
  const [qHash, pHash] = sql(
    'SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = FALSE',
    [tokenHash]
  );
  let row = await queryOne(qHash, pHash);
  if (row) {
    return { row, id: (row as any).id };
  }
  // Legacy: token stored in plaintext (token_hash IS NULL)
  const [qLegacy, pLegacy] = sql(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = FALSE AND token_hash IS NULL',
    [submittedToken]
  );
  row = await queryOne(qLegacy, pLegacy);
  if (!row) return null;
  const id = (row as any).id;
  // Migrate legacy row to token_hash so we don't need plaintext again
  const [qUp, pUp] = sql(
    'UPDATE password_reset_tokens SET token_hash = ?, token = ? WHERE id = ?',
    [tokenHash, 'h:' + id, id]
  );
  await execute(qUp, pUp);
  return { row, id };
}

router.post('/request', authRateLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    const normalizedEmail = normalizeEmail(email);

    const user = await queryOne('SELECT * FROM users WHERE email = ?', [normalizedEmail]);

    if (user && (user as any).password_hash) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const tokenId = uuidv4();
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 1);

      // Store only hash; token column holds placeholder so we don't store plaintext (H2)
      const tokenPlaceholder = 'h:' + tokenId;
      const [qIns, pIns] = sql(
        'INSERT INTO password_reset_tokens (id, user_id, token, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [tokenId, (user as any).id, tokenPlaceholder, tokenHash, expiresAt.toISOString()]
      );
      await execute(qIns, pIns);

      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      await sendPasswordResetEmail(normalizedEmail, token, resetUrl);
    }

    res.json({
      message: 'If an account with this email exists, a password reset link has been sent.',
    });
  } catch (error: any) {
    console.error('Password reset request error:', error);
    res.json({
      message: 'If an account with this email exists, a password reset link has been sent.',
    });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ valid: false, error: INVALID_OR_EXPIRED });
    }

    const found = await findResetTokenByToken(token);
    if (!found) {
      return res.status(400).json({ valid: false, error: INVALID_OR_EXPIRED });
    }

    const expiresAt = new Date((found.row as any).expires_at);
    if (expiresAt < new Date()) {
      const [qUp, pUp] = sql('UPDATE password_reset_tokens SET used = TRUE WHERE id = ?', [found.id]);
      await execute(qUp, pUp);
      return res.status(400).json({ valid: false, error: INVALID_OR_EXPIRED });
    }

    res.json({ valid: true });
  } catch (error: any) {
    console.error('Token verification error:', error);
    res.status(400).json({ valid: false, error: INVALID_OR_EXPIRED });
  }
});

router.post('/reset', authRateLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    const found = await findResetTokenByToken(token);
    if (!found) {
      return res.status(400).json({ error: INVALID_OR_EXPIRED });
    }

    const expiresAt = new Date((found.row as any).expires_at);
    if (expiresAt < new Date()) {
      const [qUp, pUp] = sql('UPDATE password_reset_tokens SET used = TRUE WHERE id = ?', [found.id]);
      await execute(qUp, pUp);
      return res.status(400).json({ error: INVALID_OR_EXPIRED });
    }

    const userId = (found.row as any).user_id;
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

    const [qUsed, pUsed] = sql('UPDATE password_reset_tokens SET used = TRUE WHERE id = ?', [found.id]);
    await execute(qUsed, pUsed);

    const [qInv, pInv] = sql(
      'UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ? AND used = FALSE',
      [userId]
    );
    await execute(qInv, pInv);

    res.json({ message: 'Password reset successfully' });
  } catch (error: any) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

export default router;
