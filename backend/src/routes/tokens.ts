import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { tokenCreateRateLimiter } from '../middleware/security.js';
import * as apiTokens from '../services/api-tokens.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/tokens:
 *   get:
 *     summary: List API tokens
 *     description: Returns the authenticated user's API tokens. Tokens are masked (sb_********************************). Never returns plaintext.
 *     tags: [API Tokens]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *       - apiTokenAuth: []
 *     responses:
 *       200:
 *         description: List of tokens
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
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *                   last_used_at:
 *                     type: string
 *                     format: date-time
 *                     nullable: true
 *       401:
 *         description: Unauthorized
 */
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  try {
    const tokens = await apiTokens.listTokens(userId, tenantId);
    res.json(tokens);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tokens:
 *   post:
 *     summary: Create API token
 *     description: Creates a new personal API token. The plaintext token is returned ONLY ONCE. Store it securely; it cannot be retrieved again.
 *     tags: [API Tokens]
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
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Descriptive name for the token (e.g. CLI, CI/CD)
 *                 maxLength: 100
 *     responses:
 *       200:
 *         description: Token created (plaintext returned once)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: The plaintext token. Store securely; never shown again.
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Validation error (name required, max tokens exceeded)
 *       401:
 *         description: Unauthorized
 *       429:
 *         description: Too many token creation attempts
 */
router.post('/', tokenCreateRateLimiter, async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Token name is required' });
  }
  const result = await apiTokens.createToken(userId, name, tenantId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.status(201).json(result.data);
});

/**
 * @swagger
 * /api/tokens/{id}:
 *   delete:
 *     summary: Revoke API token
 *     description: Revokes an API token. The token stops working immediately. Idempotent.
 *     tags: [API Tokens]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *       - apiTokenAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Token revoked
 *       400:
 *         description: Token not found
 *       401:
 *         description: Unauthorized
 */
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const tenantId = getTenantId(req);
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Token ID is required' });
  }
  const result = await apiTokens.revokeToken(userId, id, tenantId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  res.json({ message: 'Token revoked' });
});

export default router;
