/**
 * Public contact form endpoint. Accepts form submissions and sends:
 * - Confirmation email to the customer
 * - Notification to CONTACT_FORM_RECIPIENT when configured
 * M1: No PII in logs; length validation; contactRateLimiter applied in index.
 */

import { Router } from 'express';
import { validateEmail, validateLength, normalizeEmail, MAX_LENGTHS } from '../utils/validation.js';
import { sendContactConfirmationEmail, sendContactFormNotification } from '../utils/email.js';

const router = Router();

/**
 * @swagger
 * /api/contact:
 *   post:
 *     summary: Submit contact form
 *     description: Public contact form. Sends confirmation to submitter and optional notification to CONTACT_FORM_RECIPIENT.
 *     tags: [Contact]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - message
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               message:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message received
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Name, email, and message are required
 */
router.post('/', async (req, res) => {
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

  const trimmedName = nameStr.trim();
  const trimmedMessage = messageStr.trim();
  const normalizedEmail = normalizeEmail(emailStr);

  // Do not log PII (M1)
  console.log('[Contact] Form submitted');

  // Send confirmation to the customer
  const confirmationSent = await sendContactConfirmationEmail(normalizedEmail, trimmedName);
  if (!confirmationSent) {
    console.warn('Failed to send contact form confirmation email');
  }

  // Send notification to the configured recipient
  const recipient = process.env.CONTACT_FORM_RECIPIENT?.trim();
  if (recipient) {
    const notificationSent = await sendContactFormNotification(recipient, {
      name: trimmedName,
      email: normalizedEmail,
      message: trimmedMessage,
    });
    if (!notificationSent) {
      console.warn('Failed to send contact form notification to recipient');
    }
  } else {
    console.warn('CONTACT_FORM_RECIPIENT not configured - no notification sent');
  }

  res.status(200).json({ ok: true, message: "Thank you for your message. We'll get back to you soon." });
});

export default router;
