import { Router } from 'express';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import { query, queryOne, execute, isInitialized } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
import { reloadOIDCStrategies } from '../auth/oidc.js';
import { generateToken } from '../utils/jwt.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { authRateLimiter, refreshRateLimiter, strictRateLimiter } from '../middleware/security.js';
import { validateEmail, normalizeEmail, validatePassword, validateLength, sanitizeString } from '../utils/validation.js';
import { generateUserKey } from '../utils/user-key.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../config/cookies.js';
import { sendSignupVerificationEmail } from '../utils/email.js';
import crypto from 'crypto';
import { getDefaultTenantId, getTenantId, DEFAULT_TENANT_ID } from '../utils/tenant.js';
import { isCloud } from '../config/mode.js';
import { buildFrontendAbsoluteUrl } from '../utils/frontend-url.js';

const router = Router();

const DB_TYPE = process.env.DB_TYPE || 'sqlite';

/** Verification link path: in cloud the app is under /app. */
function getVerifyEmailPath(): string {
  return isCloud ? '/app/verify-email' : '/verify-email';
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Convert ? placeholders to $1, $2 for PostgreSQL */
function toPg(sqlStr: string): string {
  let n = 0;
  return sqlStr.replace(/\?/g, () => `$${++n}`);
}

function sql(sqlStr: string, params: any[]): [string, any[]] {
  return DB_TYPE === 'postgresql' ? [toPg(sqlStr), params] : [sqlStr, params];
}

/**
 * Find signup verification token by submitted token (hash-first, then legacy plaintext).
 * Returns row with id, user_id, expires_at, used; for status/resend also need email (join users).
 * Migrates legacy rows to token_hash on use.
 */
async function findSignupTokenByToken(submittedToken: string): Promise<any | null> {
  const tokenHash = hashToken(submittedToken);
  const [qHash, pHash] = sql(
    'SELECT id, user_id, expires_at, used FROM signup_verification_tokens WHERE token_hash = ?',
    [tokenHash]
  );
  let row = await queryOne(qHash, pHash);
  if (row) return row;
  // Legacy: token stored in plaintext (token_hash IS NULL)
  const [qLegacy, pLegacy] = sql(
    'SELECT id, user_id, expires_at, used FROM signup_verification_tokens WHERE token = ? AND token_hash IS NULL',
    [submittedToken]
  );
  row = await queryOne(qLegacy, pLegacy);
  if (!row) return null;
  const r = row as any;
  // Migrate legacy row to token_hash
  const [qUp, pUp] = sql(
    'UPDATE signup_verification_tokens SET token_hash = ?, token = ? WHERE id = ?',
    [tokenHash, 'h:' + r.id, r.id]
  );
  await execute(qUp, pUp);
  return row;
}

/**
 * Find signup verification token with user email (for status/resend endpoints).
 */
async function findSignupTokenWithEmailByToken(submittedToken: string): Promise<any | null> {
  const tokenHash = hashToken(submittedToken);
  const [qHash, pHash] = sql(
    `SELECT svt.id, svt.user_id, svt.expires_at, svt.used, u.email
     FROM signup_verification_tokens svt
     JOIN users u ON u.id = svt.user_id
     WHERE svt.token_hash = ?`,
    [tokenHash]
  );
  let row = await queryOne(qHash, pHash);
  if (row) return row;
  // Legacy: token stored in plaintext (token_hash IS NULL)
  const [qLegacy, pLegacy] = sql(
    `SELECT svt.id, svt.user_id, svt.expires_at, svt.used, u.email
     FROM signup_verification_tokens svt
     JOIN users u ON u.id = svt.user_id
     WHERE svt.token = ? AND svt.token_hash IS NULL`,
    [submittedToken]
  );
  row = await queryOne(qLegacy, pLegacy);
  if (!row) return null;
  const r = row as any;
  // Migrate legacy row to token_hash
  const [qUp, pUp] = sql(
    'UPDATE signup_verification_tokens SET token_hash = ?, token = ? WHERE id = ?',
    [tokenHash, 'h:' + r.id, r.id]
  );
  await execute(qUp, pUp);
  return row;
}

/** Set auth cookie for self-hosted JWT auth. */
function setAuthCookies(res: any, options: { accessToken: string; refreshToken?: string; refreshMaxAgeMs?: number }) {
  const accessMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
  res.cookie('token', options.accessToken, { ...getAuthCookieOptions(accessMaxAgeMs), maxAge: accessMaxAgeMs });
}

router.get('/providers', async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const providers = await query('SELECT id, provider_key, issuer_url FROM oidc_providers WHERE tenant_id = ?', [getDefaultTenantId()]);
    const providersList = Array.isArray(providers) ? providers : (providers ? [providers] : []);
    const providersWithCallback = providersList.map((p: any) => ({
      ...p,
      callback_url: `${baseUrl}/api/auth/${p.provider_key}/callback`,
    }));
    res.json(providersWithCallback);
  } catch (error: any) {
    console.error('Auth providers error:', error?.message ?? error);
    res.status(500).json({ error: 'An error occurred while loading sign-in options.' });
  }
});

router.get('/me', requireAuth(), async (req, res) => {
  const authReq = req as AuthRequest;
  const user = authReq.user!;
  const userRow = await queryOne('SELECT id, email, name, user_key, is_admin, language, theme, ai_suggestions_enabled FROM users WHERE id = ?', [user.id]);
  const u = userRow as any;
  const payload: Record<string, unknown> = {
    id: user.id,
    email: u?.email ?? user.email,
    name: u?.name ?? user.name,
    user_key: user.user_key,
    is_admin: user.is_admin,
    language: u?.language || (user as any).language || 'en',
    theme: u?.theme || (user as any).theme || 'auto',
    ai_suggestions_enabled: u?.ai_suggestions_enabled !== 0 && u?.ai_suggestions_enabled !== false,
  };
  if (isCloud) {
    const tenantId = getTenantId(req as any);
    let workspace_admin = false;
    if (tenantId && tenantId !== DEFAULT_TENANT_ID) {
      const m = await queryOne(
        `SELECT role FROM org_members WHERE user_id = ? AND org_id = ? AND role IN ('owner', 'admin')`,
        [user.id, tenantId]
      );
      workspace_admin = Boolean(m);
    }
    payload.workspace_admin = workspace_admin;
  }
  res.json(payload);
});

// Local authentication (email/password)
router.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Validate and normalize email
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    const normalizedEmail = normalizeEmail(email);

    // Find user by email (use normalized email)
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check if user has a password set
    if (!(user as any).password_hash) {
      return res.status(401).json({ error: 'This account does not have a password set. Please use OIDC login.' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, (user as any).password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const emailVerified = (user as any).email_verified;
    const isVerified = emailVerified !== false && emailVerified !== 0;

    // In cloud, block login until email is verified
    if (isCloud && !isVerified) {
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Please verify your email before logging in. Check your inbox for the verification link.',
      });
    }

    const userPayload = {
      id: (user as any).id,
      email: (user as any).email,
      name: (user as any).name,
      user_key: (user as any).user_key,
      is_admin: (user as any).is_admin,
      email_verified: isVerified,
    };

    // Drop any Passport session identity (e.g. prior OIDC attempt) so the next request
    // does not deserialize a different user when the JWT cookie is absent or replaced.
    try {
      await new Promise<void>((resolve, reject) => {
        const logout = (req as AuthRequest & { logout?: (cb: (err?: unknown) => void) => void }).logout;
        if (typeof logout === 'function') {
          logout.call(req, (err?: unknown) => (err ? reject(err) : resolve()));
          return;
        }
        resolve();
      });
    } catch (cleanupErr) {
      console.error('Session cleanup before login:', cleanupErr);
    }

    const token = generateToken(userPayload);
    setAuthCookies(res, { accessToken: token });

    if (isCloud && req.session) {
      delete req.session.organizationId;
      delete req.session.tenantId;
    }

    const payload: Record<string, unknown> = {
      id: (user as any).id,
      email: (user as any).email,
      name: (user as any).name,
      user_key: (user as any).user_key,
      is_admin: (user as any).is_admin,
      email_verified: isVerified,
      language: (user as any).language,
      theme: (user as any).theme,
    };
    res.json(payload);
  } catch (error: any) {
    console.error('Login error:', error?.message ?? error);
    res.status(500).json({ error: 'An error occurred during sign in.' });
  }
});

router.post('/logout', async (req, res) => {
  const clearOpts = getClearAuthCookieOptions();
  res.clearCookie('token', clearOpts);

  const sendLoggedOut = () => {
    if (isCloud && req.session) {
      delete req.session.organizationId;
      delete req.session.tenantId;
    }
    res.json({ message: 'Logged out' });
  };

  const logout = (req as AuthRequest & { logout?: (cb: (err?: unknown) => void) => void }).logout;
  if (typeof logout === 'function') {
    logout.call(req, (err?: unknown) => {
      if (err) console.error('Passport logout:', err);
      sendLoggedOut();
    });
    return;
  }
  sendLoggedOut();
});

/**
 * POST /auth/register - CLOUD only. Create account with email verification.
 * Returns 404 when not CLOUD so SELFHOSTED never exposes public registration.
 */
router.post('/register', authRateLimiter, async (req, res) => {
  const registrationsEnabled = process.env.REGISTRATIONS_ENABLED !== 'false';
  if (!registrationsEnabled) {
    return res.status(403).json({ error: 'Registrations are disabled' });
  }

  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    const normalizedEmail = normalizeEmail(email);

    const nameValidation = validateLength(name, 'Name', 1, 255);
    if (!nameValidation.valid) {
      return res.status(400).json({ error: nameValidation.error });
    }
    const sanitizedName = sanitizeString(name);

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    const existingUser = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const isFirstUser = !(await isInitialized());
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    let userKey = await generateUserKey();

    const DB_TYPE = process.env.DB_TYPE || 'sqlite';

    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        if (DB_TYPE === 'postgresql') {
          await execute(
            `INSERT INTO users (id, email, name, user_key, password_hash, is_admin, email_verified)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, normalizedEmail, sanitizedName, userKey, passwordHash, isFirstUser, false]
          );
        } else {
          await execute(
            `INSERT INTO users (id, email, name, user_key, password_hash, is_admin, email_verified)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [userId, normalizedEmail, sanitizedName, userKey, passwordHash, isFirstUser, 0]
          );
        }
        break;
      } catch (error: any) {
        if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate')) && error.message.includes('user_key')) {
          retries++;
          if (retries >= maxRetries) {
            return res.status(500).json({ error: 'Failed to complete registration. Please try again.' });
          }
          userKey = await generateUserKey();
          continue;
        }
        throw error;
      }
    }

    const tokenId = uuidv4();
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const tokenPlaceholder = 'h:' + tokenId;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiresAtStr = expiresAt.toISOString();

    if (DB_TYPE === 'postgresql') {
      await execute(
        `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenId, userId, tokenPlaceholder, tokenHash, expiresAtStr, false]
      );
    } else {
      await execute(
        `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenId, userId, tokenPlaceholder, tokenHash, expiresAtStr, 0]
      );
    }

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const verificationUrl = `${frontendUrl}${getVerifyEmailPath()}?token=${encodeURIComponent(token)}`;
    const emailSent = await sendSignupVerificationEmail(normalizedEmail, verificationUrl);
    if (!emailSent) {
      console.error('Register: verification email failed to send for', normalizedEmail);
      return res.status(500).json({ error: 'Account created but we could not send the verification email. Please try again later or contact support.' });
    }
    return res.status(201).json({ message: 'Check your email to verify your account' });
  } catch (error: any) {
    console.error('Register error:', error?.message ?? error);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

/**
 * POST /auth/verify-signup - CLOUD only. Verify signup token and set email_verified.
 */
router.post('/verify-signup', authRateLimiter, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    const row = await findSignupTokenByToken(token.trim());
    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }

    const r = row as any;
    if (r.used === true || r.used === 1) {
      return res.status(400).json({ error: 'This verification link has already been used' });
    }
    const expiresAt = new Date(r.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'This verification link has expired' });
    }

    if (DB_TYPE === 'postgresql') {
      await execute('UPDATE users SET email_verified = TRUE WHERE id = ?', [r.user_id]);
      await execute('UPDATE signup_verification_tokens SET used = TRUE WHERE id = ?', [r.id]);
    } else {
      await execute('UPDATE users SET email_verified = 1 WHERE id = ?', [r.user_id]);
      await execute('UPDATE signup_verification_tokens SET used = 1 WHERE id = ?', [r.id]);
    }

    return res.json({ message: 'Email verified. You can log in.' });
  } catch (error: any) {
    console.error('Verify-signup error:', error?.message ?? error);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

/**
 * GET /auth/signup-verification/status - CLOUD only. Get status of signup verification token.
 */
router.get('/signup-verification/status', authRateLimiter, async (req, res) => {
  try {
    const token = (req.query.token as string)?.trim();
    if (!token) {
      return res.status(400).json({ status: 'invalid' });
    }
    const row = await findSignupTokenWithEmailByToken(token);
    if (!row) {
      return res.json({ status: 'invalid' });
    }
    const r = row as any;
    if (r.used === true || r.used === 1) {
      return res.json({ status: 'used' });
    }
    const expiresAt = new Date(r.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      return res.json({ status: 'expired', email: r.email });
    }
    return res.json({ status: 'valid', email: r.email });
  } catch (error: any) {
    console.error('Signup verification status error:', error);
    return res.status(500).json({ status: 'invalid' });
  }
});

/**
 * POST /auth/resend-signup-verification - CLOUD only. Resend verification email, optionally with updated email.
 */
router.post('/resend-signup-verification', authRateLimiter, async (req, res) => {
  try {
    const { token, newEmail } = req.body;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }
    const row = await findSignupTokenWithEmailByToken(token.trim());
    if (!row) {
      return res.status(400).json({ error: 'Invalid verification token' });
    }
    const r = row as any;
    if (r.used === true || r.used === 1) {
      return res.status(400).json({ error: 'This verification link has already been used' });
    }
    let targetEmail = r.email;
    if (newEmail && typeof newEmail === 'string' && newEmail.trim()) {
      const emailValidation = validateEmail(newEmail.trim());
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }
      const normalizedNew = normalizeEmail(newEmail.trim());
      if (normalizedNew !== targetEmail) {
        const existing = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedNew]);
        if (existing) {
          return res.status(400).json({ error: 'Email already registered' });
        }
        targetEmail = normalizedNew;
        await execute('UPDATE users SET email = ? WHERE id = ?', [targetEmail, r.user_id]);
      }
    }
    await execute('DELETE FROM signup_verification_tokens WHERE user_id = ?', [r.user_id]);
    const tokenId = uuidv4();
    const newToken = crypto.randomBytes(32).toString('hex');
    const newTokenHash = hashToken(newToken);
    const newTokenPlaceholder = 'h:' + tokenId;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const expiresAtStr = expiresAt.toISOString();
    if (DB_TYPE === 'postgresql') {
      await execute(
        `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenId, r.user_id, newTokenPlaceholder, newTokenHash, expiresAtStr, false]
      );
    } else {
      await execute(
        `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenId, r.user_id, newTokenPlaceholder, newTokenHash, expiresAtStr, 0]
      );
    }
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const verificationUrl = `${frontendUrl}${getVerifyEmailPath()}?token=${encodeURIComponent(newToken)}`;
    const emailSent = await sendSignupVerificationEmail(targetEmail, verificationUrl);
    if (!emailSent) {
      console.error('Resend signup verification: email failed to send for', targetEmail);
      return res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
    }
    return res.json({ message: 'Verification email sent' });
  } catch (error: any) {
    console.error('Resend signup verification error:', error?.message ?? error);
    return res.status(500).json({ error: 'Failed to resend verification. Please try again.' });
  }
});

/**
 * POST /auth/request-signup-resend - CLOUD only. Request resend of verification email by email (no token).
 * Optional newEmail: if provided and different, update user email and send verification to new address.
 */
router.post('/request-signup-resend', authRateLimiter, async (req, res) => {
  try {
    const { email, newEmail } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const emailValidation = validateEmail(email.trim());
    if (!emailValidation.valid) {
      return res.status(400).json({ error: emailValidation.error });
    }
    const normalizedEmail = normalizeEmail(email.trim());
    const user = await queryOne(
      'SELECT id FROM users WHERE email = ? AND (email_verified = FALSE OR email_verified IS NULL)',
      [normalizedEmail]
    );
    let targetEmail = normalizedEmail;
    let emailChanged = false;
    if (user) {
      const u = user as any;
      if (newEmail && typeof newEmail === 'string' && newEmail.trim()) {
        const newEmailValidation = validateEmail(newEmail.trim());
        if (!newEmailValidation.valid) {
          return res.status(400).json({ error: newEmailValidation.error });
        }
        const normalizedNew = normalizeEmail(newEmail.trim());
        if (normalizedNew !== normalizedEmail) {
          const existing = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedNew]);
          if (existing) {
            return res.status(400).json({ error: 'Email already registered' });
          }
          await execute('UPDATE users SET email = ? WHERE id = ?', [normalizedNew, u.id]);
          targetEmail = normalizedNew;
          emailChanged = true;
        }
      }
      await execute('DELETE FROM signup_verification_tokens WHERE user_id = ?', [u.id]);
      const tokenId = uuidv4();
      const newToken = crypto.randomBytes(32).toString('hex');
      const newTokenHash = hashToken(newToken);
      const newTokenPlaceholder = 'h:' + tokenId;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const expiresAtStr = expiresAt.toISOString();
      if (DB_TYPE === 'postgresql') {
        await execute(
          `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [tokenId, u.id, newTokenPlaceholder, newTokenHash, expiresAtStr, false]
        );
      } else {
        await execute(
          `INSERT INTO signup_verification_tokens (id, user_id, token, token_hash, expires_at, used)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [tokenId, u.id, newTokenPlaceholder, newTokenHash, expiresAtStr, 0]
        );
      }
      const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
      const verificationUrl = `${frontendUrl}${getVerifyEmailPath()}?token=${encodeURIComponent(newToken)}`;
      const emailSent = await sendSignupVerificationEmail(targetEmail, verificationUrl);
      if (!emailSent) {
        console.error('Request signup resend: email failed to send for', targetEmail);
        return res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
      }
    }
    return res.json({
      message: 'If an unverified account exists with that email, a new verification link has been sent.',
      emailChanged,
    });
  } catch (error: any) {
    console.error('Request signup resend error:', error?.message ?? error);
    return res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

router.post('/refresh', refreshRateLimiter, async (req, res) => {
  return res.status(404).json({ error: 'Not found' });
});

// OIDC login route
// Note: OIDC requires sessions for the OAuth flow, so we don't use session: false here
router.get('/:provider', async (req, res, next) => {
  const { provider } = req.params;
  const strategies = (passport as any)._strategies || {};
  if (!strategies[provider]) {
    return res.status(404).json({ error: 'Not found' });
  }
  passport.authenticate(provider)(req, res, next);
});

// OIDC callback route
// Note: OIDC requires sessions for the OAuth flow, but we convert to JWT after authentication
router.get('/:provider/callback', (req, res, next) => {
  const { provider } = req.params;
  const strategies = (passport as any)._strategies || {};
  if (!strategies[provider]) {
    return res.status(404).json({ error: 'Not found' });
  }
  passport.authenticate(provider, async (err: any, user: any, info: any): Promise<void> => {
    
    // Handle "ID token not present" error - some providers don't return ID tokens
    // and passport-openidconnect fails before it can use userInfo endpoint
    if (err && err.message === 'ID token not present in token response') {
      try {
        // Get provider configuration from database.
        let configuredIssuer: string;
        let configuredUserinfoUrl: string;
        const providerConfig = await queryOne(
          'SELECT issuer_url, userinfo_url FROM oidc_providers WHERE provider_key = ? AND tenant_id = ?',
          [provider, getDefaultTenantId()]
        );
        if (!providerConfig) throw new Error('Provider configuration not found');
        configuredIssuer = (providerConfig as any).issuer_url;
        configuredUserinfoUrl = (providerConfig as any).userinfo_url || `${configuredIssuer}/userinfo`;
        
        // Get the access token from the session (stored by passport during OAuth flow)
        // passport-openidconnect stores it under a key like 'openidconnect:issuer'
        // Use the configured issuer, not user input
        const sessionKey = `openidconnect:${configuredIssuer}`;
        const oauthState = (req.session as any)?.[sessionKey];
        
        if (!oauthState) {
          // Try to find any openidconnect key in session that matches the configured issuer
          const allKeys = Object.keys(req.session as any || {});
          const oidcKeys = allKeys.filter((k: string) => k.startsWith('openidconnect:'));
          
          // Find a key that matches our configured issuer
          const matchingKey = oidcKeys.find((k: string) => k === sessionKey);
          
          if (matchingKey) {
            const matchingState = (req.session as any)?.[matchingKey];
            
            if (matchingState?.token_response?.access_token) {
              const accessToken = matchingState.token_response.access_token;
              
              // Use the configured userinfo URL (safe, from database)
              const userInfoResponse = await fetch(configuredUserinfoUrl, {
                headers: {
                  'Authorization': `Bearer ${accessToken}`,
                  'Accept': 'application/json',
                },
              });
              
              if (!userInfoResponse.ok) {
                const errorText = await userInfoResponse.text();
                throw new Error(`UserInfo request failed: ${userInfoResponse.status} ${userInfoResponse.statusText} - ${errorText}`);
              }
              
              const userInfo: any = await userInfoResponse.json();
              
              // Get the verify function from the strategy
              const strategy = (passport as any)._strategies[provider];
              if (!strategy || !strategy._verify) {
                throw new Error('Verify function not found for provider');
              }
              
              // Create a mock profile from userInfo
              const profile = {
                id: userInfo.sub || userInfo.id,
                displayName: userInfo.name || userInfo.preferred_username,
                name: userInfo.name,
                emails: userInfo.email ? [{ value: userInfo.email }] : [],
                email: userInfo.email,
              };
              
              // Call verify function with userInfo data
              strategy._verify(
                configuredIssuer,
                profile,
                {}, // context
                null, // idToken (not available in this flow)
                accessToken,
                matchingState.token_response.refresh_token,
                {}, // params
                async (verifyErr: any, verifiedUser: any) => {
                  if (verifyErr || !verifiedUser) {
                    console.error(`[OIDC] Verify function error:`, verifyErr);
                    return res.redirect(buildFrontendAbsoluteUrl('/login?error=auth_failed'));
                  }
                  user = verifiedUser;
                  await handleSuccess();
                }
              );
              
              return; // Exit early, handleSuccess already ran
            }
          }
          
          throw new Error('No OAuth state found in session');
        }
        
        const accessToken = oauthState.token_response?.access_token;
        if (!accessToken) {
          throw new Error('No access token found in token response');
        }
        
        // Use the configured userinfo URL (safe, from database, not user input)
        const userInfoResponse = await fetch(configuredUserinfoUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json',
          },
        });
        
        if (!userInfoResponse.ok) {
          const errorText = await userInfoResponse.text();
          throw new Error(`UserInfo request failed: ${userInfoResponse.status} ${userInfoResponse.statusText} - ${errorText}`);
        }
        
        const userInfo: any = await userInfoResponse.json();
        
        // Get the verify function from the strategy
        const strategy = (passport as any)._strategies[provider];
        if (!strategy || !strategy._verify) {
          throw new Error('Verify function not found for provider');
        }
        
        // Create a mock profile from userInfo
        const profile = {
          id: userInfo.sub || userInfo.id,
          displayName: userInfo.name || userInfo.preferred_username,
          name: userInfo.name,
          emails: userInfo.email ? [{ value: userInfo.email }] : [],
          email: userInfo.email,
        };
        
        // Call verify function with userInfo data
        // Updated signature: (iss, profile, context, idToken, accessToken, refreshToken, params, cb)
        strategy._verify(
          configuredIssuer,
          profile,
          {}, // context
          null, // idToken (not available in this flow)
          accessToken,
          oauthState.token_response?.refresh_token,
          {}, // params
          async (verifyErr: any, verifiedUser: any) => {
            if (verifyErr || !verifiedUser) {
              console.error(`[OIDC] Verify function error:`, verifyErr);
              return res.redirect(buildFrontendAbsoluteUrl('/login?error=auth_failed'));
            }
            user = verifiedUser;
            await handleSuccess();
          }
        );
        
        return; // Exit early, handleSuccess already ran
      } catch (manualFetchError: any) {
        console.error(`[OIDC] Manual userInfo fetch failed:`, {
          message: manualFetchError.message,
          stack: manualFetchError.stack,
        });
        return res.redirect(buildFrontendAbsoluteUrl('/login?error=auth_failed'));
      }
    }
    
    if (err || !user) {
      // Check for specific error types
      let errorParam = 'auth_failed';
      if (err) {
        // Sanitize provider for logging to prevent log injection
        const safeProvider = String(provider || 'unknown').replace(/[^\w-]/g, '');
        console.error('[OIDC] Authentication error', {
          provider: safeProvider,
          message: err.message,
          stack: err.stack,
          name: err.name,
        });
        if (err.message === 'AUTO_CREATE_DISABLED') {
          errorParam = 'auto_create_disabled';
        }
      } else if (!user) {
        // Sanitize provider for logging to prevent log injection
        const safeProvider = String(provider || 'unknown').replace(/[^\w-]/g, '');
        console.error('[OIDC] No user returned', {
          provider: safeProvider,
          info: info,
        });
      }
      return res.redirect(buildFrontendAbsoluteUrl(`/login?error=${encodeURIComponent(errorParam)}`));
    }
    
    async function handleSuccess() {
      const userPayload = { id: user.id, email: user.email, name: user.name, user_key: user.user_key, is_admin: user.is_admin };
      const token = generateToken(userPayload);
      setAuthCookies(res, { accessToken: token });
      const redirectUrl = buildFrontendAbsoluteUrl('/');
      req.session?.destroy((sessionErr) => {
        if (sessionErr) console.error('Error destroying session:', sessionErr);
        res.redirect(redirectUrl);
      });
    }
    
    // If we got here normally (not from manual fetch), handle success
    if (user) {
      await handleSuccess();
    }
  })(req, res, next);
});

// Setup route - only accessible when system is not initialized. SELFHOSTED only.
router.post('/setup', strictRateLimiter, async (req, res) => {
  try {
    const initialized = await isInitialized();
    if (initialized) {
      return res.status(403).json({ error: 'System already initialized' });
    }

    const { email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
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

    // Validate password complexity
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ error: passwordValidation.error });
    }

    // Check if email already exists (use normalized email)
    const existingUser = await queryOne('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create first admin user
    const userId = uuidv4();
    let userKey = await generateUserKey();
    
    // Retry logic for user_key collisions (should be extremely rare)
    let retries = 0;
    const maxRetries = 3;
    while (retries < maxRetries) {
      try {
        await execute(
          `INSERT INTO users (id, email, name, user_key, password_hash, is_admin) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, normalizedEmail, sanitizedName, userKey, passwordHash, true] // First user is always admin
        );
        break; // Success, exit retry loop
      } catch (error: any) {
        // If user_key collision, generate new key and retry
        if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate')) 
            && error.message.includes('user_key')) {
          retries++;
          if (retries >= maxRetries) {
            return res.status(500).json({ error: 'Failed to complete setup. Please try again.' });
          }
          userKey = await generateUserKey();
          continue; // Retry with new key
        }
        // For other errors (like email duplicate), throw to outer catch
        throw error;
      }
    }

    // Automatically log in the user after successful setup
    const userPayload = { id: userId, email: normalizedEmail, name: sanitizedName, user_key: userKey, is_admin: true };
    setAuthCookies(res, { accessToken: generateToken(userPayload) });

    // Return user data (same format as login endpoint)
    res.json({
      id: userId,
      email: normalizedEmail,
      name: sanitizedName,
      user_key: userKey,
      is_admin: true,
      language: 'en', // Default language
      theme: 'auto', // Default theme
    });
  } catch (error: any) {
    // Handle unique constraint violations
    if (error.message && (error.message.includes('UNIQUE constraint') || error.message.includes('duplicate'))) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    console.error('Setup error:', error?.message ?? error);
    res.status(500).json({ error: 'An error occurred during setup. Please try again.' });
  }
});

router.get('/setup/status', async (req, res) => {
  try {
    const initialized = await isInitialized();
    res.json({ initialized });
  } catch (error: any) {
    console.error('Setup status error:', error?.message ?? error);
    res.status(500).json({ error: 'An error occurred.' });
  }
});

export default router;
