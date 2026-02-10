/**
 * CLOUD mode: public contact form endpoint. Stub that accepts and logs; no email sent.
 */

import { Router } from 'express';
import { isCloud } from '../config/mode.js';

const router = Router();

router.post('/', (req, res) => {
  if (!isCloud) return res.status(404).json({ error: 'Not found' });
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }
  // Stub: log only; integrate with email/queue later
  console.log('[Contact]', { name, email, message: (message as string).slice(0, 200) });
  res.status(200).json({ ok: true });
});

export default router;
