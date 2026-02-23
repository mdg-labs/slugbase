import { Router } from 'express';
import crypto from 'crypto';
import { query, queryOne, execute } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { validateEmail, normalizeEmail, validatePassword, validateLength, sanitizeString } from '../../utils/validation.js';
import { generateUserKey } from '../../utils/user-key.js';
import { getTenantId } from '../../utils/tenant.js';
import { sendInviteEmail, isEmailSendingAvailable } from '../../utils/email.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const users = await query(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users ORDER BY created_at DESC',
      []
    );
    const usersList = Array.isArray(users) ? users : (users ? [users] : []);
    res.json(usersList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const user = await queryOne(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users WHERE id = ?',
      [id]
    );
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { email, name, password, is_admin = false, send_invite: sendInvite = false } = req.body;

    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    if (sendInvite && password) {
      return res.status(400).json({
        error: 'Cannot set password and send invite. Either set a password or choose "Send invite email".',
      });
    }

    if (sendInvite) {
      const emailAvailable = await isEmailSendingAvailable();
      if (!emailAvailable) {
        return res.status(400).json({
          error: 'Invite by email is not available. Configure SMTP in Settings or set a password for the user.',
        });
      }
    }

    // Validate and normalize email
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    const normalizedEmail = normalizeEmail(email);

    // Validate name length
    const nameValidation = validateLength(name, 'Name', 1, 255);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    // Validate password if provided (and not invite path)
    if (password) {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
    }

    // Check if email already exists (use normalized email)
    const existingUser = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const userId = uuidv4();
    let userKey = await generateUserKey();
    let passwordHash = null;

    if (password) {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      passwordHash = await bcrypt.hash(password, 10);
    }

    // Retry logic for user_key collisions (should be extremely rare)
    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        await execute(
          `INSERT INTO users (id, email, name, user_key, password_hash, is_admin) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, normalizedEmail, sanitizedName, userKey, passwordHash, is_admin]
        );
        break; // Success, exit retry loop
      } catch (error: any) {
        // If user_key collision, generate new key and retry
        if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))
            && error.message.includes('user_key')) {
          retries++;
          if (retries >= maxRetries) {
            return res.status(500).json({ error: 'Failed to create user. Please try again.' });
          }
          userKey = await generateUserKey();
          continue; // Retry with new key
        }
        // For other errors (like email duplicate), throw to outer catch
        throw error;
      }
    }

    let inviteSent = false;
    if (sendInvite) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(token);
      const tokenId = uuidv4();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);
      const tokenPlaceholder = 'h:' + tokenId;
      await execute(
        'INSERT INTO password_reset_tokens (id, user_id, token, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [tokenId, userId, tokenPlaceholder, tokenHash, expiresAt.toISOString()]
      );
      const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const setPasswordUrl = `${baseUrl}/reset-password?token=${token}`;
      inviteSent = await sendInviteEmail(normalizedEmail, setPasswordUrl, sanitizedName);
      if (!inviteSent) {
        console.warn('Invite email could not be sent for new user', userId);
      }
    }

    const user = await queryOne(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users WHERE id = ?',
      [userId]
    );
    const payload: any = { ...user };
    if (sendInvite) {
      payload.inviteSent = inviteSent;
    }
    res.status(201).json(payload);
  } catch (error: any) {
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const { email, name, password, is_admin, language, theme } = req.body;

    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    const updates: string[] = [];
    const params: any[] = [];

    // Validate email if provided
    if (email !== undefined) {
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }
      const normalizedEmail = normalizeEmail(email);
      // Check email uniqueness if changed
      if (normalizedEmail !== (existing as any).email) {
        const emailExists = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [normalizedEmail, id]);
        if (emailExists) {
          return res.status(400).json({ error: 'User with this email already exists' });
        }
      }
      updates.push('email = ?');
      params.push(normalizedEmail);
    }
    if (name !== undefined) {
      const nameValidation = validateLength(name, 'Name', 1, 255);
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error });
      }
      updates.push('name = ?');
      params.push(sanitizeString(name));
    }
    if (password !== undefined && password !== null && password !== '') {
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 10));
    }
    if (is_admin !== undefined) {
      updates.push('is_admin = ?');
      params.push(is_admin);
    }
    if (language !== undefined) {
      updates.push('language = ?');
      params.push(language);
    }
    if (theme !== undefined) {
      updates.push('theme = ?');
      params.push(theme);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(id);
    await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    const user = await queryOne(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users WHERE id = ?',
      [id]
    );
    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;

    // Prevent deleting yourself
    if (id === authReq.user!.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await execute('DELETE FROM users WHERE id = ?', [id]);

    res.json({ message: 'User deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/teams', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    const tenantId = getTenantId(req);
    const teams = await query(
      `SELECT t.* FROM teams t
       INNER JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = ? AND tm.tenant_id = ? AND t.tenant_id = ?`,
      [id, tenantId, tenantId]
    );
    const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
    res.json(teamsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
