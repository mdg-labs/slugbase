import { Router } from 'express';
import { generateCSRFToken } from '../middleware/security.js';

const router = Router();

// Route is mounted at /api/csrf-token, so this handles GET /api/csrf-token
router.get('/', (req, res) => {
  try {
    const token = generateCSRFToken(req, res);
    res.json({ csrfToken: token });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate CSRF token' });
  }
});

export default router;
