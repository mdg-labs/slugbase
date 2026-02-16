import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter } from '../middleware/security.js';
import { validateEmail, normalizeEmail } from '../utils/validation.js';
import { deleteOrganization, ensureOrgForUser, FREE_BOOKMARK_LIMIT, getCurrentOrgId, getFreePlanGraceEndsAt, setCurrentOrg, setFreePlanGraceIfOverLimit } from '../utils/organizations.js';
import { isCloud } from '../config/mode.js';
import { sendOrgInvitationEmail } from '../utils/email.js';

const router = Router();

/**
 * @swagger
 * /api/organizations:
 *   get:
 *     summary: List organizations
 *     description: Returns all organizations the authenticated user is a member of. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of organizations
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   name:
 *                     type: string
 *                   plan:
 *                     type: string
 *                   role:
 *                     type: string
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Not found (self-hosted mode)
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
 * @swagger
 * /api/organizations/me:
 *   get:
 *     summary: Get current organization
 *     description: Returns the current user's organization with members and usage. Creates org if user has none. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current organization details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 plan:
 *                   type: string
 *                 role:
 *                   type: string
 *                 member_count:
 *                   type: number
 *                 members:
 *                   type: array
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Organization not found
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
  const userRow = await queryOne('SELECT current_org_id FROM users WHERE id = ?', [userId]);
  const dbCurrentOrgId = (userRow as any)?.current_org_id;
  if (orgId !== dbCurrentOrgId) {
    await setCurrentOrg(userId, orgId);
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

  // Bookmark usage for Free plan (per-user)
  let bookmark_count: number | undefined;
  let bookmark_limit: number | null = null;
  let free_plan_grace_ends_at: string | null = null;
  if (plan === 'free') {
    const countResult = await queryOne('SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?', [userId]);
    bookmark_count = countResult ? parseInt((countResult as any).count) : 0;
    bookmark_limit = FREE_BOOKMARK_LIMIT;
    free_plan_grace_ends_at = await getFreePlanGraceEndsAt(userId);
  }

  res.json({
    id: org.id,
    name: org.name,
    plan: org.plan,
    stripe_customer_id: org.stripe_customer_id || null,
    included_seats: includedSeats,
    member_count: parseInt((memberCount as any)?.count || '0'),
    role: org.role,
    members: Array.isArray(members) ? members : [members],
    ai_enabled: org.ai_enabled === 1 || org.ai_enabled === true,
    ...(bookmark_count !== undefined && { bookmark_count }),
    bookmark_limit,
    ...(free_plan_grace_ends_at && { free_plan_grace_ends_at }),
  });
});

/**
 * @swagger
 * /api/organizations/me/ai:
 *   patch:
 *     summary: Update org AI settings
 *     description: Enable or disable AI suggestions for the organization. Org owner/admin only. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ai_enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Updated
 *       403:
 *         description: Only owners and admins can update
 */
router.patch('/me/ai', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = await getCurrentOrgId(userId);
  if (!orgId) {
    return res.status(404).json({ error: 'No organization selected' });
  }
  const membership = await queryOne(
    'SELECT role FROM org_members WHERE user_id = ? AND org_id = ?',
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const role = (membership as any).role;
  if (role !== 'owner' && role !== 'admin') {
    return res.status(403).json({ error: 'Only owners and admins can update AI settings' });
  }
  const { ai_enabled } = req.body;
  if (ai_enabled !== undefined) {
    const DB_TYPE = process.env.DB_TYPE || 'sqlite';
    const val = ai_enabled === true || ai_enabled === 'true';
    await execute(
      'UPDATE organizations SET ai_enabled = ? WHERE id = ?',
      [DB_TYPE === 'postgresql' ? val : (val ? 1 : 0), orgId]
    );
  }
  res.json({ message: 'AI settings updated' });
});

/**
 * @swagger
 * /api/organizations/me/switch:
 *   put:
 *     summary: Switch current organization
 *     description: Switches the user's current organization context. Cloud mode only.
 *     tags: [Organizations]
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
 *                 description: Organization ID to switch to
 *     responses:
 *       200:
 *         description: Organization switched successfully
 *       400:
 *         description: org_id is required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Not a member of this organization
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
 * @swagger
 * /api/organizations/members:
 *   get:
 *     summary: List organization members
 *     description: Returns all members of the current organization. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of organization members
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   email:
 *                     type: string
 *                   name:
 *                     type: string
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: No organization selected
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
 * @swagger
 * /api/organizations/{id}/invite:
 *   post:
 *     summary: Invite user to organization
 *     description: Sends an invitation email to join the organization. Org admin/owner only. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
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
 *     responses:
 *       201:
 *         description: Invitation sent
 *       400:
 *         description: Invalid email or user already member
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Only owners and admins can invite
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
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const tokenPlaceholder = 'h:' + inviteId;
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await execute(
    `INSERT INTO org_invitations (id, org_id, email, invited_by, token, token_hash, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [inviteId, orgId, normalizedEmail, userId, tokenPlaceholder, tokenHash, expiresAt.toISOString()]
  );
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const acceptUrl = `${frontendUrl}/app/accept-invite?token=${encodeURIComponent(token)}`;
  await sendOrgInvitationEmail(normalizedEmail, acceptUrl, (org as any).name);
  res.status(201).json({ message: 'Invitation sent' });
});

/**
 * @swagger
 * /api/organizations/{id}/members/{userId}:
 *   delete:
 *     summary: Remove member from organization
 *     description: Owner or admin removes a member. Cannot remove yourself (use leave). Cannot remove the last owner. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to remove
 *     responses:
 *       200:
 *         description: Member removed
 *       400:
 *         description: Cannot remove yourself; use leave
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Only owners and admins can remove members; cannot remove last owner
 *       404:
 *         description: Organization or member not found
 */
router.delete('/:id/members/:userId', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const actorId = authReq.user!.id;
  const orgId = req.params.id;
  const targetUserId = req.params.userId;

  if (actorId === targetUserId) {
    return res.status(400).json({ error: 'Cannot remove yourself; use leave organization instead' });
  }

  const actorMembership = await queryOne(
    'SELECT role FROM org_members WHERE user_id = ? AND org_id = ?',
    [actorId, orgId]
  );
  if (!actorMembership) {
    return res.status(404).json({ error: 'Organization not found' });
  }
  const actorRole = (actorMembership as any).role;
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    return res.status(403).json({ error: 'Only owners and admins can remove members' });
  }

  const targetMembership = await queryOne(
    'SELECT role FROM org_members WHERE user_id = ? AND org_id = ?',
    [targetUserId, orgId]
  );
  if (!targetMembership) {
    return res.status(404).json({ error: 'Member not found' });
  }
  const targetRole = (targetMembership as any).role;

  if (targetRole === 'owner') {
    const ownerCountRow = await queryOne(
      'SELECT COUNT(*) as count FROM org_members WHERE org_id = ? AND role = ?',
      [orgId, 'owner']
    );
    const ownerCount = parseInt((ownerCountRow as any)?.count || '0');
    if (ownerCount <= 1) {
      return res.status(403).json({ error: 'Cannot remove the last owner; transfer ownership first or they must leave' });
    }
  }

  await execute('DELETE FROM org_members WHERE user_id = ? AND org_id = ?', [targetUserId, orgId]);
  await execute('UPDATE users SET current_org_id = NULL WHERE id = ? AND current_org_id = ?', [targetUserId, orgId]);

  await setFreePlanGraceIfOverLimit(targetUserId);

  const remainingCountRow = await queryOne(
    'SELECT COUNT(*) as count FROM org_members WHERE org_id = ?',
    [orgId]
  );
  const remainingCount = parseInt((remainingCountRow as any)?.count || '0');
  if (remainingCount === 0) {
    try {
      await deleteOrganization(orgId);
    } catch (err: any) {
      console.warn('Org cleanup after member remove failed:', err?.message);
    }
  }

  res.json({ message: 'Member removed' });
});

/**
 * @swagger
 * /api/organizations/{id}/leave:
 *   post:
 *     summary: Leave organization
 *     description: Removes the current user from the organization. If sole member, the org is deleted. Cloud mode only.
 *     tags: [Organizations]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Organization ID
 *     responses:
 *       200:
 *         description: Left organization
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Organization not found or not a member
 */
router.post('/:id/leave', requireAuth(), async (req, res) => {
  if (!isCloud) {
    return res.status(404).json({ error: 'Not found' });
  }
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = req.params.id;

  const membership = await queryOne(
    'SELECT 1 FROM org_members WHERE user_id = ? AND org_id = ?',
    [userId, orgId]
  );
  if (!membership) {
    return res.status(404).json({ error: 'Organization not found or you are not a member' });
  }

  await execute('DELETE FROM org_members WHERE user_id = ? AND org_id = ?', [userId, orgId]);
  await execute('UPDATE users SET current_org_id = NULL WHERE id = ? AND current_org_id = ?', [userId, orgId]);

  await setFreePlanGraceIfOverLimit(userId);

  const remainingCountRow = await queryOne(
    'SELECT COUNT(*) as count FROM org_members WHERE org_id = ?',
    [orgId]
  );
  const remainingCount = parseInt((remainingCountRow as any)?.count || '0');
  if (remainingCount === 0) {
    try {
      await deleteOrganization(orgId);
    } catch (err: any) {
      console.warn('Org cleanup after leave failed:', err?.message);
    }
  }

  res.json({ message: 'Left organization' });
});

export default router;
