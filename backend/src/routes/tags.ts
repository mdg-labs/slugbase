import { Router } from 'express';
import { query, queryOne, execute } from '../db/index.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { validateLength, sanitizeString, MAX_LENGTHS } from '../utils/validation.js';
import { getTenantId } from '../utils/tenant.js';
import { recordAuditEvent } from '../services/audit-log.js';

const router = Router();
router.use(requireAuth());

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
    await recordAuditEvent(req, {
      action: 'tag.created',
      entityType: 'tag',
      entityId: tagId,
      metadata: { name: sanitizedName },
    });
    res.status(201).json(tag);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
    await recordAuditEvent(req, {
      action: 'tag.updated',
      entityType: 'tag',
      entityId: id,
      metadata: { name: sanitizedName },
    });
    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
    await recordAuditEvent(req, {
      action: 'tag.deleted',
      entityType: 'tag',
      entityId: id,
      metadata: { name: (tag as any).name },
    });
    res.json({ message: 'Tag deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
