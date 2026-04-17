/**
 * MFA routes under /api/auth/mfa/*. Mounted before /:provider so "mfa" is not treated as OIDC.
 */

import { Router } from 'express';
import { queryOne } from '../db/index.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { mfaVerifyRateLimiter, mfaEnrollBeginRateLimiter } from '../middleware/security.js';
import { generateToken } from '../utils/jwt.js';
import { setAccessTokenCookie } from '../utils/access-token-cookie.js';
import { verifyMfaPendingToken } from '../utils/mfa-pending-jwt.js';
import { MFA_PENDING_COOKIE_NAME, getClearMfaPendingCookieOptions } from '../config/cookies.js';
import { isCloud } from '../config/mode.js';
import {
  getMfaStatus,
  enrollBegin,
  enrollConfirm,
  enrollCancel,
  disableMfa,
  regenerateBackupCodes,
  verifyMfaStepUp,
} from '../services/mfa-user.js';
import { logMfaAudit } from '../utils/mfa-audit-log.js';

export function mountAuthMfaRoutes(router: Router): void {
  router.get('/mfa/status', requireAuth(), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const status = await getMfaStatus(authReq.user!.id);
      res.json({ enabled: status.enabled, enrolled_at: status.enrolled_at });
    } catch (e: any) {
      console.error('MFA status error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/enroll/begin', mfaEnrollBeginRateLimiter, requireAuth(), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const began = await enrollBegin(authReq.user!.id, authReq.user!.email);
      if ('error' in began) {
        logMfaAudit('mfa_enroll_begin_conflict', { user_id: authReq.user!.id });
        return res.status(409).json({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
      }
      logMfaAudit('mfa_enroll_begin', { user_id: authReq.user!.id });
      res.json({ otpauth_url: began.otpauth_url, secret: began.secret });
    } catch (e: any) {
      console.error('MFA enroll begin error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/enroll/confirm', mfaEnrollBeginRateLimiter, requireAuth(), async (req, res) => {
    try {
      const raw = req.body?.code;
      if (!raw || typeof raw !== 'string') {
        return res.status(400).json({ error: 'Code is required' });
      }
      const authReq = req as AuthRequest;
      const result = await enrollConfirm(authReq.user!.id, raw);
      if (!result.ok) {
        logMfaAudit('mfa_enroll_confirm_fail', { user_id: authReq.user!.id });
        if (result.reason === 'already_enabled') {
          return res.status(409).json({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
        }
        if (result.reason === 'no_pending_enrollment') {
          return res.status(400).json({ error: 'No enrollment in progress', code: 'MFA_NO_PENDING' });
        }
        return res.status(400).json({ error: 'Invalid code', code: 'INVALID_CODE' });
      }
      logMfaAudit('mfa_enroll_confirm_success', { user_id: authReq.user!.id });
      res.json({ backup_codes: result.backup_codes });
    } catch (e: any) {
      console.error('MFA enroll confirm error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/enroll/cancel', mfaEnrollBeginRateLimiter, requireAuth(), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const result = await enrollCancel(authReq.user!.id);
      if (!result.ok && result.reason === 'already_enabled') {
        return res.status(409).json({ error: 'MFA is already enabled', code: 'MFA_ALREADY_ENABLED' });
      }
      logMfaAudit('mfa_enroll_cancel', { user_id: authReq.user!.id });
      res.json({ ok: true });
    } catch (e: any) {
      console.error('MFA enroll cancel error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/disable', mfaVerifyRateLimiter, requireAuth(), async (req, res) => {
    try {
      const code = req.body?.code;
      const password = req.body?.password;
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Code is required' });
      }
      const authReq = req as AuthRequest;
      const result = await disableMfa(authReq.user!.id, {
        rawCode: code,
        password: typeof password === 'string' ? password : undefined,
      });
      if (!result.ok) {
        logMfaAudit('mfa_disable_fail', { user_id: authReq.user!.id });
        if (result.reason === 'not_enabled') {
          return res.status(400).json({ error: 'MFA is not enabled', code: 'MFA_NOT_ENABLED' });
        }
        if (result.reason === 'password_required') {
          return res.status(400).json({ error: 'Password is required', code: 'PASSWORD_REQUIRED' });
        }
        if (result.reason === 'invalid_password') {
          return res.status(401).json({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
        }
        return res.status(400).json({ error: 'Invalid code', code: 'INVALID_CODE' });
      }
      logMfaAudit('mfa_disable_success', { user_id: authReq.user!.id });
      res.json({ ok: true });
    } catch (e: any) {
      console.error('MFA disable error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/backup/regenerate', mfaVerifyRateLimiter, requireAuth(), async (req, res) => {
    try {
      const code = req.body?.code;
      const password = req.body?.password;
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Code is required' });
      }
      const authReq = req as AuthRequest;
      const result = await regenerateBackupCodes(authReq.user!.id, {
        rawCode: code,
        password: typeof password === 'string' ? password : undefined,
      });
      if (!result.ok) {
        logMfaAudit('mfa_backup_regenerate_fail', { user_id: authReq.user!.id });
        if (result.reason === 'not_enabled') {
          return res.status(400).json({ error: 'MFA is not enabled', code: 'MFA_NOT_ENABLED' });
        }
        if (result.reason === 'password_required') {
          return res.status(400).json({ error: 'Password is required', code: 'PASSWORD_REQUIRED' });
        }
        if (result.reason === 'invalid_password') {
          return res.status(401).json({ error: 'Invalid password', code: 'INVALID_PASSWORD' });
        }
        return res.status(400).json({ error: 'Invalid code', code: 'INVALID_CODE' });
      }
      logMfaAudit('mfa_backup_regenerate_success', { user_id: authReq.user!.id });
      res.json({ backup_codes: result.backup_codes });
    } catch (e: any) {
      console.error('MFA backup regenerate error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });

  router.post('/mfa/verify', mfaVerifyRateLimiter, async (req, res) => {
    try {
      const rawCookie = req.cookies?.[MFA_PENDING_COOKIE_NAME];
      const pending = verifyMfaPendingToken(typeof rawCookie === 'string' ? rawCookie : '');
      if (!pending) {
        logMfaAudit('mfa_verify_fail');
        return res.status(401).json({
          error: 'MFA session expired. Please sign in again.',
          code: 'MFA_PENDING_INVALID',
        });
      }
      const code = req.body?.code;
      if (!code || typeof code !== 'string') {
        return res.status(400).json({ error: 'Code is required' });
      }

      if (isCloud) {
        const userRowEarly = await queryOne(
          'SELECT id, email_verified FROM users WHERE id = ?',
          [pending.sub]
        );
        if (!userRowEarly) {
          logMfaAudit('mfa_verify_fail', { user_id: pending.sub });
          res.clearCookie(MFA_PENDING_COOKIE_NAME, getClearMfaPendingCookieOptions());
          return res.status(401).json({
            error: 'MFA session expired. Please sign in again.',
            code: 'MFA_PENDING_INVALID',
          });
        }
        const uEarly = userRowEarly as any;
        const emailVerifiedEarly = uEarly.email_verified !== false && uEarly.email_verified !== 0;
        if (!emailVerifiedEarly) {
          logMfaAudit('mfa_verify_fail', { user_id: pending.sub });
          return res.status(403).json({
            code: 'EMAIL_NOT_VERIFIED',
            error: 'Please verify your email before logging in. Check your inbox for the verification link.',
          });
        }
      }

      const ok = await verifyMfaStepUp(pending.sub, code);
      if (!ok) {
        logMfaAudit('mfa_verify_fail', { user_id: pending.sub });
        return res.status(401).json({ error: 'Invalid code', code: 'INVALID_CODE' });
      }

      const userRow = await queryOne(
        'SELECT id, email, name, user_key, is_admin, email_verified, language, theme FROM users WHERE id = ?',
        [pending.sub]
      );
      if (!userRow) {
        logMfaAudit('mfa_verify_fail', { user_id: pending.sub });
        res.clearCookie(MFA_PENDING_COOKIE_NAME, getClearMfaPendingCookieOptions());
        return res.status(401).json({
          error: 'MFA session expired. Please sign in again.',
          code: 'MFA_PENDING_INVALID',
        });
      }

      const u = userRow as any;
      const emailVerified = u.email_verified !== false && u.email_verified !== 0;

      logMfaAudit('mfa_verify_success', { user_id: pending.sub });
      res.clearCookie(MFA_PENDING_COOKIE_NAME, getClearMfaPendingCookieOptions());

      const userPayload = {
        id: u.id,
        email: u.email,
        name: u.name,
        user_key: u.user_key,
        is_admin: u.is_admin,
        email_verified: emailVerified,
      };
      const token = generateToken(userPayload);
      setAccessTokenCookie(res, token);

      if (isCloud && req.session) {
        delete req.session.organizationId;
        delete req.session.tenantId;
      }

      res.json({
        id: u.id,
        email: u.email,
        name: u.name,
        user_key: u.user_key,
        is_admin: u.is_admin,
        email_verified: emailVerified,
        language: u.language,
        theme: u.theme,
      });
    } catch (e: any) {
      console.error('MFA verify error:', e?.message ?? e);
      res.status(500).json({ error: 'Request failed' });
    }
  });
}
