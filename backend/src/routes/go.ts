/**
 * /go slug forwarding and slug preferences API
 * Single canonical forwarding: GET /go/:slug
 * Preferences API: GET/POST/DELETE /api/go/preferences
 */

import { Router, Request, Response } from 'express';
import passport from 'passport';
import { query, queryOne, execute } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { canAccessBookmark } from '../auth/authorization.js';
import { getAccessibleBookmarksBySlug } from './go-helpers.js';
import { validateUrl, validateSlug } from '../utils/validation.js';
import { isCloud } from '../config/mode.js';
import { getCurrentOrgId } from '../utils/organizations.js';

const router = Router();
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const baseUrl = process.env.BASE_URL || 'http://localhost:5000';

/** Login path for redirect (unauthenticated users) - use frontend URL for SPA login page */
function loginPath(redirectPath: string): string {
  const path = isCloud ? '/app/login' : '/login';
  const encoded = encodeURIComponent(redirectPath);
  return `${frontendUrl}${path}?redirect=${encoded}`;
}

/** Optional auth: try JWT; if no user, redirect to login */
export function optionalAuthForGo(req: Request, res: Response, next: () => void) {
  passport.authenticate('jwt', { session: false }, (err: any, user: any) => {
    if (err) {
      return res.redirect(302, loginPath(req.path));
    }
    if (!user) {
      return res.redirect(302, loginPath(req.path));
    }
    (req as AuthRequest).user = user;
    next();
  })(req, res, next);
}

/**
 * Escape HTML for safe inclusion in server-rendered pages
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Friendly not-found HTML page
 */
function notFoundHtml(slug: string): string {
  const safeSlug = escapeHtml(slug);
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Not Found - SlugBase</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 2rem auto; padding: 1rem;">
  <h1>Bookmark not found</h1>
  <p>No bookmark with slug <code>${safeSlug}</code> was found in your collection.</p>
  <p>Make sure you're logged in and the bookmark exists with forwarding enabled.</p>
</body>
</html>`;
}

/**
 * Collision selection HTML page (multiple bookmarks match slug)
 */
function collisionHtml(
  slug: string,
  candidates: Array<{ id: string; title: string; url: string; workspace: string }>
): string {
  const safeSlug = escapeHtml(slug);
  const rows = candidates
    .map(
      (c) =>
        `<tr>
          <td><a href="${escapeHtml(c.url)}">${escapeHtml(c.title)}</a></td>
          <td>${escapeHtml(c.workspace)}</td>
          <td><a href="/go/${encodeURIComponent(slug)}/remember/${encodeURIComponent(c.id)}">Always use this</a></td>
        </tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Choose bookmark - SlugBase</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 1rem;">
  <h1>Multiple bookmarks match "${safeSlug}"</h1>
  <p>Choose which one to open:</p>
  <table style="width:100%; border-collapse: collapse;">
    <thead>
      <tr style="text-align:left;"><th>Title</th><th>Source</th><th></th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

/**
 * GET /go/:slug - Main forwarding endpoint
 * 1. Check remembered preference
 * 2. Search accessible bookmarks
 * 3. 0 → not-found, 1 → redirect, 2+ → collision UI
 */
export function handleGoSlug(req: Request, res: Response) {
  const slug = req.params.slug;
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;

  const slugValidation = validateSlug(slug);
  if (!slugValidation.valid) {
    return res.status(400).send('Invalid slug');
  }

  (async () => {
    const orgId = isCloud ? await getCurrentOrgId(userId) : null;
    // Step 1: Check remembered preference
    const pref = await queryOne(
      'SELECT bookmark_id FROM slug_preferences WHERE user_id = ? AND slug = ?',
      [userId, slug]
    );
    if (pref) {
      const bookmarkId = (pref as any).bookmark_id;
      const hasAccess = await canAccessBookmark(userId, bookmarkId, orgId);
      if (hasAccess) {
        const bookmark = await queryOne(
          'SELECT id, url, slug, forwarding_enabled FROM bookmarks WHERE id = ?',
          [bookmarkId]
        );
        if (bookmark && (bookmark as any).forwarding_enabled) {
          const url = (bookmark as any).url;
          const urlValidation = validateUrl(url);
          if (urlValidation.valid) {
            execute(
              `UPDATE bookmarks SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [bookmarkId]
            ).catch((err) => console.error('Failed to track bookmark access:', err));
            return res.redirect(302, url);
          }
        }
      }
      await execute('DELETE FROM slug_preferences WHERE user_id = ? AND slug = ?', [userId, slug]);
    }

    // Step 2: Search accessible bookmarks
    const candidates = await getAccessibleBookmarksBySlug(userId, slug, orgId);

    if (candidates.length === 0) {
      return res.status(404).type('text/html').send(notFoundHtml(slug));
    }

    if (candidates.length === 1) {
      const b = candidates[0];
      const urlValidation = validateUrl(b.url);
      if (!urlValidation.valid) {
        return res.status(400).send('Invalid redirect URL');
      }
      execute(
        `UPDATE bookmarks SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [b.id]
      ).catch((err) => console.error('Failed to track bookmark access:', err));
      return res.redirect(302, b.url);
    }

    // Step 3: Multiple matches - collision UI
    return res.type('text/html').send(
      collisionHtml(
        slug,
        candidates.map((c) => ({ id: c.id, title: c.title, url: c.url, workspace: c.workspace }))
      )
    );
  })().catch((err) => {
    console.error('Go slug error:', err);
    res.status(500).send('Internal Server Error');
  });
}

/**
 * GET /go/:slug/remember/:bookmarkId - Create preference and redirect to bookmark
 * Used from collision page "Always use this" links
 */
export async function handleGoRemember(
  req: Request,
  res: Response
) {
  const { slug, bookmarkId } = req.params;
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = isCloud ? await getCurrentOrgId(userId) : null;

  const hasAccess = await canAccessBookmark(userId, bookmarkId, orgId);
  if (!hasAccess) {
    return res.status(403).send('Forbidden');
  }

  const bookmark = await queryOne(
    'SELECT id, url, slug, forwarding_enabled FROM bookmarks WHERE id = ?',
    [bookmarkId]
  );
  if (!bookmark || (bookmark as any).slug !== slug || !(bookmark as any).forwarding_enabled) {
    return res.status(404).send('Not Found');
  }

  const urlValidation = validateUrl((bookmark as any).url);
  if (!urlValidation.valid) {
    return res.status(400).send('Invalid redirect URL');
  }

  await execute(
    `INSERT INTO slug_preferences (user_id, slug, bookmark_id, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, slug) DO UPDATE SET bookmark_id = excluded.bookmark_id, updated_at = CURRENT_TIMESTAMP`,
    [userId, slug, bookmarkId]
  );

  execute(
    `UPDATE bookmarks SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [bookmarkId]
  ).catch((err) => console.error('Failed to track bookmark access:', err));

  return res.redirect(302, (bookmark as any).url);
}

// --- API routes (mounted at /api/go) ---

async function getOwnerName(userId: string): Promise<string> {
  const row = await queryOne('SELECT name, email FROM users WHERE id = ?', [userId]);
  if (!row) return 'Shared';
  const r = row as any;
  return r.name || r.email || 'Shared';
}

/**
 * @swagger
 * /api/go/preferences:
 *   get:
 *     summary: List slug preferences
 *     description: Returns the user's slug-to-bookmark preferences for collision resolution.
 *     tags: [Go]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of slug preferences
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   slug:
 *                     type: string
 *                   bookmark_id:
 *                     type: string
 *                   title:
 *                     type: string
 *                   url:
 *                     type: string
 *                   workspace:
 *                     type: string
 *       401:
 *         description: Unauthorized
 */
router.get('/preferences', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  try {
    const rows = await query(
      `SELECT sp.slug, sp.bookmark_id, sp.created_at, sp.updated_at, b.title, b.url, b.user_id
       FROM slug_preferences sp
       INNER JOIN bookmarks b ON sp.bookmark_id = b.id
       WHERE sp.user_id = ?
       ORDER BY sp.slug ASC`,
      [userId]
    );
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    const result = await Promise.all(
      list.map(async (r: any) => {
        const workspace =
          r.user_id === userId ? 'Personal' : await getOwnerName(r.user_id);
        return {
          slug: r.slug,
          bookmark_id: r.bookmark_id,
          title: r.title,
          url: r.url,
          workspace,
          created_at: r.created_at,
          updated_at: r.updated_at,
        };
      })
    );
    res.json(result);
  } catch (error: any) {
    console.error('List preferences error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/go/preferences:
 *   post:
 *     summary: Create or update slug preference
 *     description: Sets which bookmark to use when multiple match a slug. User must have access to the bookmark.
 *     tags: [Go]
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
 *               - slug
 *               - bookmark_id
 *             properties:
 *               slug:
 *                 type: string
 *               bookmark_id:
 *                 type: string
 *     responses:
 *       201:
 *         description: Preference created or updated
 *       400:
 *         description: slug and bookmark_id required
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Bookmark not found or slug mismatch
 */
router.post('/preferences', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const orgId = isCloud ? await getCurrentOrgId(userId) : null;
  const { slug, bookmark_id } = req.body;
  if (!slug || !bookmark_id) {
    return res.status(400).json({ error: 'slug and bookmark_id are required' });
  }
  const slugVal = validateSlug(slug);
  if (!slugVal.valid) {
    return res.status(400).json({ error: slugVal.error });
  }
  const hasAccess = await canAccessBookmark(userId, bookmark_id, orgId);
  if (!hasAccess) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const bookmark = await queryOne(
    'SELECT id, slug, forwarding_enabled FROM bookmarks WHERE id = ?',
    [bookmark_id]
  );
  if (!bookmark || (bookmark as any).slug !== slug || !(bookmark as any).forwarding_enabled) {
    return res.status(404).json({ error: 'Bookmark not found or slug mismatch' });
  }
  try {
    await execute(
      `INSERT INTO slug_preferences (user_id, slug, bookmark_id, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, slug) DO UPDATE SET bookmark_id = excluded.bookmark_id, updated_at = CURRENT_TIMESTAMP`,
      [userId, slug, bookmark_id]
    );
    res.status(201).json({ slug, bookmark_id });
  } catch (error: any) {
    console.error('Create preference error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/go/preferences/{slug}:
 *   delete:
 *     summary: Remove slug preference
 *     description: Removes the user's preference for a slug.
 *     tags: [Go]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Preference removed
 *       400:
 *         description: Invalid slug
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Preference not found
 */
router.delete('/preferences/:slug', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user!.id;
  const { slug } = req.params;
  const slugVal = validateSlug(slug);
  if (!slugVal.valid) {
    return res.status(400).json({ error: slugVal.error });
  }
  try {
    const result = await execute(
      'DELETE FROM slug_preferences WHERE user_id = ? AND slug = ?',
      [userId, slug]
    );
    const affected = (result as any)?.changes ?? (result as any)?.rowCount ?? 0;
    if (affected === 0) {
      return res.status(404).json({ error: 'Preference not found' });
    }
    res.status(204).send();
  } catch (error: any) {
    console.error('Delete preference error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
