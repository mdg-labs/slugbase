import { Router } from 'express';
import { queryOne, execute } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/security.js';
import { normalizeEmail } from '../utils/validation.js';
import { isCloud } from '../config/mode.js';

const router = Router();

/**
 * GET /invitations/verify?token=xxx — Verify invite token (public, rate-limited).
 */
router.get('/verify', authRateLimiter, async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const token = (req.query.token as string)?.trim();
  if (!token) {
    return res.status(400).json({ valid: false, error: 'Token is required' });
  }
  const row = await queryOne(
    `SELECT oi.*, o.name as org_name
     FROM org_invitations oi
     INNER JOIN organizations o ON o.id = oi.org_id
     WHERE oi.token = ? AND oi.status = ?`,
    [token, 'pending']
  );
  if (!row) {
    return res.json({ valid: false, error: 'Invalid or expired invitation' });
  }
  const r = row as any;
  const expiresAt = new Date(r.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    await execute('UPDATE org_invitations SET status = ? WHERE id = ?', ['expired', r.id]);
    return res.json({ valid: false, error: 'Invitation has expired' });
  }
  res.json({ valid: true, email: r.email, org_name: r.org_name });
});

/**
 * POST /invitations/accept — Accept org invitation (authenticated).
 */
router.post('/accept', requireAuth(), authRateLimiter, async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Token is required' });
  }
  const row = await queryOne(
    `SELECT oi.*, o.name as org_name
     FROM org_invitations oi
     INNER JOIN organizations o ON o.id = oi.org_id
     WHERE oi.token = ? AND oi.status = ?`,
    [token.trim(), 'pending']
  );
  if (!row) {
    return res.status(400).json({ error: 'Invalid or expired invitation' });
  }
  const r = row as any;
  const expiresAt = new Date(r.expires_at);
  if (expiresAt.getTime() < Date.now()) {
    await execute('UPDATE org_invitations SET status = ? WHERE id = ?', ['expired', r.id]);
    return res.status(400).json({ error: 'Invitation has expired' });
  }
  const authReq = req as AuthRequest;
  if (!authReq.user) {
    return res.status(401).json({ error: 'You must be logged in to accept this invitation' });
  }
  const userId = authReq.user.id;
  const normalizedInviteEmail = normalizeEmail(r.email);
  const userEmail = normalizeEmail(authReq.user.email);
  if (normalizedInviteEmail !== userEmail) {
    return res.status(403).json({ error: 'This invitation was sent to a different email address' });
  }
  const existingMember = await queryOne(
    'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
    [userId, r.org_id]
  );
  if (existingMember) {
    await execute('UPDATE org_invitations SET status = ? WHERE id = ?', ['accepted', r.id]);
    return res.json({ message: 'You are already a member of this organization' });
  }
  await execute(
    'INSERT INTO org_members (user_id, org_id, role) VALUES (?, ?, ?)',
    [userId, r.org_id, 'member']
  );
  await execute('UPDATE org_invitations SET status = ? WHERE id = ?', ['accepted', r.id]);
  await execute('UPDATE users SET current_org_id = ? WHERE id = ?', [r.org_id, userId]);
  res.json({ message: 'Invitation accepted', org_id: r.org_id });
});

export default router;
