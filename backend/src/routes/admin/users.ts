import { Router, type Request } from 'express';
import crypto from 'crypto';
import { query, queryOne, execute, getDbType } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { validateEmail, normalizeEmail, validatePassword, validateLength, sanitizeString } from '../../utils/validation.js';
import { generateUserKey } from '../../utils/user-key.js';
import { getTenantId, DEFAULT_TENANT_ID } from '../../utils/tenant.js';
import { sendInviteEmail, isEmailSendingAvailable } from '../../utils/email.js';
import { isCloud } from '../../config/mode.js';
import { recordAuditEvent } from '../../services/audit-log.js';
import { spinOffCloudUserFromOrg } from '../../services/cloud-spin-off-user.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

const USER_COLUMNS =
  'id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at';

function unusedResetTokenSql(alias: string): string {
  return getDbType() === 'postgresql' ? `${alias}.used IS DISTINCT FROM TRUE` : `(${alias}.used = 0 OR ${alias}.used IS NULL)`;
}

function mapUserListRow(row: Record<string, unknown>) {
  const invitePendingRaw = row.invite_pending;
  const invite_pending =
    invitePendingRaw === true ||
    invitePendingRaw === 1 ||
    invitePendingRaw === '1' ||
    invitePendingRaw === 'true';
  const exp = row.invite_expires_at as string | null | undefined;
  const invite_expires_at = exp != null && String(exp).trim() !== '' ? String(exp) : null;
  let invite_expired = false;
  if (invite_pending && invite_expires_at) {
    invite_expired = Date.now() >= new Date(invite_expires_at).getTime();
  }
  const rest = { ...(row as Record<string, unknown>) };
  delete rest.invite_pending;
  delete rest.invite_expires_at;
  return {
    ...rest,
    invite_pending,
    invite_expires_at,
    invite_expired,
  };
}

async function rollbackNewInviteUser(userId: string, tenantId: string | null) {
  await execute('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
  if (isCloud && tenantId && tenantId !== DEFAULT_TENANT_ID) {
    await execute('DELETE FROM org_members WHERE user_id = ? AND org_id = ?', [userId, tenantId]);
  }
  await execute('DELETE FROM users WHERE id = ?', [userId]);
}

async function userInCurrentOrg(req: Request, targetUserId: string): Promise<boolean> {
  if (!isCloud) return true;
  const tenantId = getTenantId(req);
  if (!tenantId || tenantId === DEFAULT_TENANT_ID) return false;
  const row = await queryOne('SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?', [tenantId, targetUserId]);
  return Boolean(row);
}

function isInstanceGlobalAdmin(req: Request): boolean {
  const u = (req as AuthRequest).user as { is_admin?: boolean | number } | undefined;
  return u?.is_admin === true || u?.is_admin === 1;
}

function isInvitePendingUser(u: { password_hash?: unknown; oidc_provider?: unknown; oidc_sub?: unknown }): boolean {
  if (u.password_hash != null && String(u.password_hash).trim() !== '') return false;
  if (u.oidc_provider != null && String(u.oidc_provider).trim() !== '') return false;
  if (u.oidc_sub != null && String(u.oidc_sub).trim() !== '') return false;
  return true;
}

const INVITE_PENDING_CASE = `CASE WHEN u.password_hash IS NULL
  AND (u.oidc_provider IS NULL OR u.oidc_provider = '')
  AND (u.oidc_sub IS NULL OR u.oidc_sub = '')
  THEN 1 ELSE 0 END`;

router.get('/', async (req, res) => {
  try {
    const prtUnused = unusedResetTokenSql('prt');
    const inviteExpirySub = `(SELECT prt.expires_at FROM password_reset_tokens prt
      WHERE prt.user_id = u.id AND ${prtUnused}
      ORDER BY prt.expires_at DESC LIMIT 1)`;
    const tenantId = getTenantId(req);
    if (isCloud && tenantId !== DEFAULT_TENANT_ID) {
      const users = await query(
        `SELECT u.id, u.email, u.name, u.user_key, u.is_admin, u.oidc_provider, u.language, u.theme, u.created_at,
         ${INVITE_PENDING_CASE} AS invite_pending,
         ${inviteExpirySub} AS invite_expires_at
         FROM users u
         INNER JOIN org_members om ON om.user_id = u.id
         WHERE om.org_id = ?
         ORDER BY u.created_at DESC`,
        [tenantId]
      );
      const usersList = Array.isArray(users) ? users : users ? [users] : [];
      return res.json(usersList.map((r) => mapUserListRow(r as Record<string, unknown>)));
    }
    if (isCloud) {
      return res.json([]);
    }
    const users = await query(
      `SELECT u.id, u.email, u.name, u.user_key, u.is_admin, u.oidc_provider, u.language, u.theme, u.created_at,
       ${INVITE_PENDING_CASE} AS invite_pending,
       ${inviteExpirySub} AS invite_expires_at
       FROM users u ORDER BY u.created_at DESC`,
      []
    );
    const usersList = Array.isArray(users) ? users : users ? [users] : [];
    res.json(usersList.map((r) => mapUserListRow(r as Record<string, unknown>)));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/resend-invite', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await queryOne(
      'SELECT id, email, name, password_hash, oidc_provider, oidc_sub FROM users WHERE id = ?',
      [id]
    );
    if (!target || !(await userInCurrentOrg(req, id))) {
      return res.status(404).json({ error: 'User not found' });
    }
    const t = target as any;
    if (!isInvitePendingUser(t)) {
      return res.status(400).json({ error: 'User is not pending invite signup.' });
    }
    const emailAvailable = await isEmailSendingAvailable();
    if (!emailAvailable) {
      return res.status(400).json({
        error: 'Invite by email is not available. Configure SMTP in Settings or use a deployment with outbound email.',
      });
    }
    const prtTable = 'password_reset_tokens';
    await execute(
      `UPDATE ${prtTable} SET used = ? WHERE user_id = ? AND (${unusedResetTokenSql(prtTable)})`,
      [true, id]
    );

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const tokenId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    const tokenPlaceholder = 'h:' + tokenId;
    await execute(
      'INSERT INTO password_reset_tokens (id, user_id, token, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
      [tokenId, id, tokenPlaceholder, tokenHash, expiresAt.toISOString()]
    );
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const setPasswordUrl = `${baseUrl}/reset-password?token=${token}`;
    const sendResult = await sendInviteEmail(String(t.email), setPasswordUrl, String(t.name || ''));
    if (!sendResult.success) {
      await execute('DELETE FROM password_reset_tokens WHERE id = ?', [tokenId]);
      const msg = sendResult.error || 'Could not send invite email';
      return res.status(502).json({ error: msg.length > 500 ? msg.slice(0, 500) + '…' : msg });
    }
    await recordAuditEvent(req, {
      action: 'org_member.invite_resent',
      entityType: 'org_member',
      entityId: id,
      metadata: { email: t.email },
    });
    res.json({ invite_expires_at: expiresAt.toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await queryOne(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await userInCurrentOrg(req, id))) {
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
  try {
    const tenantIdForPlan = getTenantId(req);
    if (isCloud && tenantIdForPlan !== DEFAULT_TENANT_ID && (req as any).plan !== 'team') {
      return res.status(403).json({
        error: 'Adding organization members is available on the Team plan. Upgrade to invite more members.',
      });
    }

    const { email, name, password, is_admin: bodyIsAdmin = false, send_invite: sendInvite = false } = req.body;
    const is_admin = isCloud && !isInstanceGlobalAdmin(req) ? false : bodyIsAdmin;

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

    const tenantId = getTenantId(req);
    if (isCloud && tenantId !== DEFAULT_TENANT_ID) {
      await execute('INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, ?)', [
        userId,
        tenantId,
        'member',
      ]);
    }

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
      const inviteResult = await sendInviteEmail(normalizedEmail, setPasswordUrl, sanitizedName);
      if (!inviteResult.success) {
        await rollbackNewInviteUser(userId, tenantId);
        const msg = inviteResult.error || 'Could not send invite email';
        return res.status(502).json({ error: msg.length > 500 ? msg.slice(0, 500) + '…' : msg });
      }
    }

    const user = await queryOne(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users WHERE id = ?',
      [userId]
    );
    const payload: any = { ...user };
    await recordAuditEvent(req, {
      action: 'org_member.created',
      entityType: 'org_member',
      entityId: userId,
      metadata: { email: normalizedEmail, name: sanitizedName, invite: Boolean(sendInvite) },
    });
    res.status(201).json(payload);
  } catch (error: any) {
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, password, is_admin, language, theme } = req.body;

    const existing = await queryOne('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await userInCurrentOrg(req, id))) {
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
      if (!isCloud || isInstanceGlobalAdmin(req)) {
        updates.push('is_admin = ?');
        params.push(is_admin);
      }
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
    await recordAuditEvent(req, {
      action: 'user.updated',
      entityType: 'org_member',
      entityId: id,
      metadata: { email: (user as any)?.email, fields: Object.keys(req.body) },
    });
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
    if (!(await userInCurrentOrg(req, id))) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (isCloud) {
      const fromTenantId = getTenantId(req);
      if (!fromTenantId || fromTenantId === DEFAULT_TENANT_ID) {
        return res.status(400).json({ error: 'No organization context' });
      }
      const membership = await queryOne('SELECT role FROM org_members WHERE user_id = ? AND org_id = ?', [
        id,
        fromTenantId,
      ]);
      if ((membership as { role?: string } | null)?.role === 'owner') {
        return res.status(403).json({ error: 'Cannot remove the organization owner.' });
      }

      const { newOrgId } = await spinOffCloudUserFromOrg({
        userId: id,
        fromTenantId,
        userEmail: String((user as { email?: string }).email || ''),
      });

      await recordAuditEvent(req, {
        action: 'org_member.removed_to_personal_workspace',
        entityType: 'org_member',
        entityId: id,
        metadata: {
          email: (user as any).email,
          from_org: fromTenantId,
          to_org: newOrgId,
        },
      });

      return res.json({
        message: 'User removed from organization; personal workspace created.',
        new_org_id: newOrgId,
      });
    }

    await recordAuditEvent(req, {
      action: 'org_member.deleted',
      entityType: 'org_member',
      entityId: id,
      metadata: { email: (user as any).email },
    });
    await execute('DELETE FROM users WHERE id = ?', [id]);

    res.json({ message: 'User deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/teams', async (req, res) => {
  try {
    const { id } = req.params;
    if (!(await userInCurrentOrg(req, id))) {
      return res.status(404).json({ error: 'User not found' });
    }
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
