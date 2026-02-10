/**
 * CLOUD mode: public contact form endpoint. Stub that accepts and logs; no email sent.
 * M1: No PII in logs; length validation; contactRateLimiter applied in index.
 */

import { Router } from 'express';
import { isCloud } from '../config/mode.js';
import { validateEmail, validateLength, MAX_LENGTHS } from '../utils/validation.js';

const router = Router();

router.post('/', (req, res) => {
  if (!isCloud) return res.status(404).json({ error: 'Not found' });
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  const nameStr = typeof name === 'string' ? name : String(name);
  const emailStr = typeof email === 'string' ? email : String(email);
  const messageStr = typeof message === 'string' ? message : String(message);

  const nameValidation = validateLength(nameStr, 'Name', 1, MAX_LENGTHS.name);
  if (!nameValidation.valid) {
    return res.status(400).json({ error: nameValidation.error });
  }
  const emailValidation = validateEmail(emailStr);
  if (!emailValidation.valid) {
    return res.status(400).json({ error: emailValidation.error });
  }
  const messageValidation = validateLength(messageStr, 'Message', 1, MAX_LENGTHS.contactMessage);
  if (!messageValidation.valid) {
    return res.status(400).json({ error: messageValidation.error });
  }

  // Do not log PII (M1)
  console.log('[Contact] Form submitted');
  res.status(200).json({ ok: true });
});

export default router;
