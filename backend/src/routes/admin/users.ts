import { Router } from 'express';
import { query, queryOne, execute } from '../../db/index.js';
import { AuthRequest, requireAuth, requireAdmin } from '../../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { validateEmail, normalizeEmail, validatePassword, validateLength, sanitizeString } from '../../utils/validation.js';
import { generateUserKey } from '../../utils/user-key.js';
import { isCloud } from '../../config/mode.js';
import { getCurrentOrgId } from '../../utils/organizations.js';

const router = Router();
router.use(requireAuth());
router.use(requireAdmin());

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get all users
 *     description: Returns a list of all users in the system. Admin only.
 *     tags: [Admin - Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
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
 *                   email:
 *                     type: string
 *                     example: "user@example.com"
 *                   name:
 *                     type: string
 *                     example: "John Doe"
 *                   user_key:
 *                     type: string
 *                     example: "abc12345"
 *                   is_admin:
 *                     type: boolean
 *                     example: false
 *                   oidc_provider:
 *                     type: string
 *                     nullable: true
 *                     example: "google"
 *                   language:
 *                     type: string
 *                     example: "en"
 *                   theme:
 *                     type: string
 *                     example: "auto"
 *                   created_at:
 *                     type: string
 *                     format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.get('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    if (isCloud) {
      const orgId = await getCurrentOrgId(authReq.user!.id);
      if (!orgId) {
        return res.json([]);
      }
      const users = await query(
        `SELECT u.id, u.email, u.name, u.user_key, u.is_admin, u.oidc_provider, u.language, u.theme, u.created_at
         FROM users u
         INNER JOIN org_members om ON u.id = om.user_id
         WHERE om.org_id = ?
         ORDER BY u.name`,
        [orgId]
      );
      const usersList = Array.isArray(users) ? users : (users ? [users] : []);
      return res.json(usersList);
    }
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

/**
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     description: Returns detailed information about a specific user. Admin only.
 *     tags: [Admin - Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: User details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 email:
 *                   type: string
 *                 name:
 *                   type: string
 *                 user_key:
 *                   type: string
 *                 is_admin:
 *                   type: boolean
 *                 oidc_provider:
 *                   type: string
 *                   nullable: true
 *                 language:
 *                   type: string
 *                 theme:
 *                   type: string
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
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

/**
 * @swagger
 * /api/admin/users:
 *   post:
 *     summary: Create a new user
 *     description: Creates a new user account. Password is optional if user will use OIDC login. Admin only.
 *     tags: [Admin - Users]
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
 *               - email
 *               - name
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "newuser@example.com"
 *               name:
 *                 type: string
 *                 example: "New User"
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 description: Optional password (required for local login)
 *                 example: "securepassword123"
 *               is_admin:
 *                 type: boolean
 *                 default: false
 *                 example: false
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 email:
 *                   type: string
 *                 name:
 *                   type: string
 *                 user_key:
 *                   type: string
 *                 is_admin:
 *                   type: boolean
 *       400:
 *         description: Missing required fields, invalid email format, or email already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 */
router.post('/', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { email, name, password, is_admin = false } = req.body;

    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
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

    // Validate password if provided
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

    const user = await queryOne(
      'SELECT id, email, name, user_key, is_admin, oidc_provider, language, theme, created_at FROM users WHERE id = ?',
      [userId]
    );
    res.status(201).json(user);
  } catch (error: any) {
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/admin/users/{id}:
 *   put:
 *     summary: Update user
 *     description: Updates an existing user. All fields are optional. Password will be hashed if provided. Admin only.
 *     tags: [Admin - Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "updated@example.com"
 *               name:
 *                 type: string
 *                 example: "Updated Name"
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 description: New password (will be hashed)
 *                 example: "newpassword123"
 *               is_admin:
 *                 type: boolean
 *                 example: false
 *               language:
 *                 type: string
 *                 enum: [en, de, fr]
 *                 example: "en"
 *               theme:
 *                 type: string
 *                 enum: [light, dark, auto]
 *                 example: "auto"
 *     responses:
 *       200:
 *         description: User updated successfully
 *       400:
 *         description: Invalid email format or email already exists
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
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

/**
 * @swagger
 * /api/admin/users/{id}:
 *   delete:
 *     summary: Delete user
 *     description: Deletes a user account. Cannot delete your own account. Admin only.
 *     tags: [Admin - Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: User deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "User deleted"
 *       400:
 *         description: Cannot delete your own account
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
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

/**
 * @swagger
 * /api/admin/users/{id}/teams:
 *   get:
 *     summary: Get teams for a user
 *     description: Returns all teams that a specific user is a member of. Admin only.
 *     tags: [Admin - Users]
 *     security:
 *       - cookieAuth: []
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *         example: "123e4567-e89b-12d3-a456-426614174000"
 *     responses:
 *       200:
 *         description: List of teams the user is a member of
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
 *                     example: "Development Team"
 *                   description:
 *                     type: string
 *                     nullable: true
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Admin access required
 *       404:
 *         description: User not found
 */
router.get('/:id/teams', async (req, res) => {
  const authReq = req as AuthRequest;
  try {
    const { id } = req.params;
    if (isCloud) {
      const orgId = await getCurrentOrgId(authReq.user!.id);
      if (!orgId) {
        return res.json([]);
      }
      const teams = await query(
        `SELECT t.* FROM teams t
         INNER JOIN team_members tm ON t.id = tm.team_id
         WHERE tm.user_id = ? AND t.org_id = ?`,
        [id, orgId]
      );
      const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
      return res.json(teamsList);
    }
    const teams = await query(
      `SELECT t.* FROM teams t
       INNER JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.user_id = ?`,
      [id]
    );
    const teamsList = Array.isArray(teams) ? teams : (teams ? [teams] : []);
    res.json(teamsList);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
