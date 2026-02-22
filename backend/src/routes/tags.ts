import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';
import { getTenantId } from '../utils/tenant.js';

const router = Router();
router.use(requireAuth());

/**
 * @swagger
 * /api/tags:
 *   get:
 *     summary: Get all tags
 *     description: Returns all tags for the authenticated user
 *     tags: [Tags]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tags
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                     example: "123e4567-e89b-12d3-a456-426614174000"
 *                   name:
 *                     type: string
 *                     example: "work"
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized
 */
// Get all tags for user. When limit is provided, returns { items, total }; otherwise returns array (backward compat)
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const usePagination = limitParam != null && limitParam !== '';
    const limit = usePagination ? Math.min(500, Math.max(1, parseInt(String(limitParam), 10) || 50)) : 0;
    const offset = usePagination ? Math.max(0, parseInt(String(offsetParam), 10) || 0) : 0;

    const sortBy = (req.query.sort_by as string) || 'alphabetical';
    let orderBy = 'ORDER BY name ASC';
    if (sortBy === 'recently_added') {
      orderBy = 'ORDER BY created_at DESC';
    }

    let total = 0;
    if (usePagination) {
      const countRow = await queryOne('SELECT COUNT(*) as total FROM tags WHERE user_id = ? AND tenant_id = ?', [userId, tenantId]);
      total = countRow ? parseInt((countRow as any).total, 10) : 0;
    }

    const tags = await query(
      `SELECT * FROM tags WHERE user_id = ? AND tenant_id = ? ${orderBy}${usePagination ? ' LIMIT ? OFFSET ?' : ''}`,
      usePagination ? [userId, tenantId, limit, offset] : [userId, tenantId]
    );

    if (usePagination) {
      return res.json({ items: tags, total });
    }
    res.json(tags);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tags/{id}:
 *   get:
 *     summary: Get tag by ID
 *     description: Returns a single tag by ID. User must own the tag.
 *     tags: [Tags]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Tag ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Tag details
 *       404:
 *         description: Tag not found
 *       401:
 *         description: Unauthorized
 */
// Get single tag
router.get('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const tag = await queryOne('SELECT * FROM tags WHERE id = ? AND user_id = ? AND tenant_id = ?', [id, userId, tenantId]);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    res.json(tag);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tags:
 *   post:
 *     summary: Create a new tag
 *     description: Creates a new tag. Tag names must be unique per user.
 *     tags: [Tags]
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
 *                 example: "work"
 *     responses:
 *       201:
 *         description: Tag created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Missing name or tag with same name already exists
 *       401:
 *         description: Unauthorized
 */
// Create tag
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Validate and sanitize name
    const nameValidation = validateLength(name, 'Name', 1, MAX_LENGTHS.tagName);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    // Check if tag with same name exists
    const existing = await queryOne('SELECT id FROM tags WHERE user_id = ? AND tenant_id = ? AND name = ?', [userId, tenantId, sanitizedName]);
    if (existing) {
      return res.status(400).json({ error: 'Tag with this name already exists' });
    }

    const tagId = uuidv4();
    await execute('INSERT INTO tags (id, tenant_id, user_id, name) VALUES (?, ?, ?, ?)', [tagId, tenantId, userId, sanitizedName]);

    const tag = await queryOne('SELECT * FROM tags WHERE id = ? AND tenant_id = ?', [tagId, tenantId]);
    res.status(201).json(tag);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tags/{id}:
 *   put:
 *     summary: Update tag
 *     description: Updates an existing tag. User must own the tag. Tag names must be unique per user.
 *     tags: [Tags]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Tag ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
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
 *                 example: "updated-tag-name"
 *     responses:
 *       200:
 *         description: Tag updated successfully
 *       400:
 *         description: Missing name or tag with same name already exists
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Tag not found
 */
// Update tag
router.put('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const tag = await queryOne('SELECT * FROM tags WHERE id = ? AND user_id = ? AND tenant_id = ?', [id, userId, tenantId]);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    // Validate and sanitize name
    const nameValidation = validateLength(name, 'Name', 1, MAX_LENGTHS.tagName);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    // Check if new name conflicts
    const existing = await queryOne('SELECT id FROM tags WHERE user_id = ? AND tenant_id = ? AND name = ? AND id != ?', [userId, tenantId, sanitizedName, id]);
    if (existing) {
      return res.status(400).json({ error: 'Tag with this name already exists' });
    }

    await execute('UPDATE tags SET name = ? WHERE id = ? AND tenant_id = ?', [sanitizedName, id, tenantId]);
    const updated = await queryOne('SELECT * FROM tags WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tags/{id}:
 *   delete:
 *     summary: Delete tag
 *     description: Deletes a tag. User must own the tag. This removes the tag from all bookmarks.
 *     tags: [Tags]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Tag ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: Tag deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Tag deleted"
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Tag not found
 */
// Delete tag
router.delete('/:id', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const userId = authReq.user!.id;
    const tenantId = getTenantId(req);
    const { id } = req.params;

    const tag = await queryOne('SELECT * FROM tags WHERE id = ? AND user_id = ? AND tenant_id = ?', [id, userId, tenantId]);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    await execute('DELETE FROM tags WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ message: 'Tag deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
