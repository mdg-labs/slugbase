import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/security.js';
import { validateEmail, normalizeEmail } from '../utils/validation.js';
import { ensureOrgForUser, getCurrentOrgId, setCurrentOrg } from '../utils/organizations.js';
import { isCloud } from '../config/mode.js';
import { sendOrgInvitationEmail } from '../utils/email.js';

const router = Router();

/**
 * GET /organizations — List organizations user is in (Cloud only).
 */
router.get('/', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgs = await query(
    `SELECT o.*, om.role FROM organizations o
     INNER JOIN org_members om ON o.id = om.org_id
     WHERE om.user_id = ?
     ORDER BY o.name`,
    [userId]
  );
  const orgList = Array.isArray(orgs) ? orgs : orgs ? [orgs] : [];
  res.json(orgList);
});

/**
 * GET /organizations/me — Get current user's organization (Cloud only).
 * Creates org if user has none (backfill for existing users).
 */
router.get('/me', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const userName = authReq.user!.name;
  await ensureOrgForUser(userId, userName);
  let orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    const first = await queryOne(
      'SELECT org_id FROM org_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT 1',
      [userId]
    );
    if (first) {
      const firstOrgId = (first as any).org_id;
      if (firstOrgId) {
        orgId = firstOrgId;
        await setCurrentOrg(userId, firstOrgId);
      }
    }
  }
  if (!orgId) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const row = await queryOne(
    `SELECT o.*, om.role
     FROM organizations o
     INNER JOIN org_members om ON o.id = om.org_id
     WHERE om.user_id = ? AND o.id = ?`,
    [userId, orgId]
  );
  if (!row) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const org = row as any;
  const plan = org.plan || 'free';
  const includedSeats = plan === 'team' ? (org.included_seats ?? 5) : 1;
  const memberCount = await queryOne(
    'SELECT COUNT(*) as count FROM org_members WHERE org_id = ?',
    [org.id]
  );
  const members = await query(
    `SELECT u.id, u.email, u.name, om.role, om.joined_at
     FROM org_members om
     INNER JOIN users u ON u.id = om.user_id
     WHERE om.org_id = ?
     ORDER BY om.joined_at ASC`,
    [org.id]
  );
  res.json({
    id: org.id,
    name: org.name,
    plan: org.plan,
    stripe_customer_id: org.stripe_customer_id || null,
    included_seats: includedSeats,
    member_count: parseInt((memberCount as any)?.count || '0'),
    role: org.role,
    members: Array.isArray(members) ? members : [members],
  });
});

/**
 * PUT /organizations/me/switch — Switch current org (Cloud only).
 */
router.put('/me/switch', requireAuth(), async (req, res) => {
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

/**
 * GET /organizations/members — List members of current org (Cloud only).
 */
router.get('/members', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    return res.status(404).json({ error: 'No organization selected' });
  }
  const members = await query(
    `SELECT u.id, u.email, u.name FROM users u
     INNER JOIN org_members om ON u.id = om.user_id
     WHERE om.org_id = ?
     ORDER BY u.name`,
    [orgId]
  );
  const list = Array.isArray(members) ? members : members ? [members] : [];
  res.json(list);
});

/**
 * POST /organizations/:id/invite — Invite user by email (Cloud only, org admin/owner).
 */
router.post('/:id/invite', requireAuth(), authRateLimiter, async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = req.params.id;
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required' });
  }
  const emailValidation = validateEmail(email.trim());
  if (!emailValidation.valid) {
    return res.status(400).json({ error: emailValidation.error });
  }
  const normalizedEmail = normalizeEmail(email.trim());
  const membership = await queryOne(
    'SELECT role FROM org_members WHERE user_id = ? AND org_id = ?',
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const role = (membership as any).role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Only owners and admins can invite members' });
  }
  const org = await queryOne('SELECT * FROM organizations WHERE id = ?', [orgId]);
  if (!org) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const existingMember = await queryOne(
    'SELECT 1 FROM org_members om INNER JOIN users u ON u.id = om.user_id WHERE om.org_id = ? AND u.email = ?',
    [orgId, normalizedEmail]
  );
  if (existingMember) {
    return res.status(400).json({ error: 'User is already a member' });
  }
  const existingInvite = await queryOne(
    'SELECT id FROM org_invitations WHERE org_id = ? AND email = ? AND status = ?',
    [orgId, normalizedEmail, 'pending']
  );
  if (existingInvite) {
    return res.status(400).json({ error: 'An invitation has already been sent to this email' });
  }
  const memberCountRow = await queryOne(
    'SELECT COUNT(*) as count FROM org_members WHERE org_id = ?',
    [orgId]
  );
  const memberCount = parseInt((memberCountRow as any)?.count || '0');
  const plan = (org as any).plan || 'free';
  const maxSeats = plan === 'team' ? 5 : 1;
  if (memberCount >= maxSeats) {
    return res.status(403).json({
      error: plan === 'team'
        ? 'Team plan includes 5 members. Upgrade your subscription for additional seats.'
        : 'Your plan allows only 1 member. Upgrade to Team plan to invite more members.',
    });
  }
  const inviteId = uuidv4();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await execute(
    `INSERT INTO org_invitations (id, org_id, email, invited_by, token, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [inviteId, orgId, normalizedEmail, userId, token, expiresAt.toISOString()]
  );
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const acceptUrl = `${frontendUrl}/app/accept-invite?token=${encodeURIComponent(token)}`;
  await sendOrgInvitationEmail(normalizedEmail, acceptUrl, (org as any).name);
  res.status(201).json({ message: 'Invitation sent' });
});

export default router;
