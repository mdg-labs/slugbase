import { Request, Response, NextFunction, RequestHandler } from 'express';
import passport from 'passport';
import { validateToken } from '../services/api-tokens.js';
import { extractTokenFromRequest } from '../utils/jwt.js';

const isCloudRuntime = process.env.SLUGBASE_MODE === 'cloud';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    name: string;
    user_key: string;
    is_admin: boolean;
  };
}

// Type guard to check if request is AuthRequest
export function isAuthRequest(req: Request): req is AuthRequest {
  return 'user' in req;
}

/**
 * Middleware to authenticate requests using JWT or API token.
 * Priority: JWT (cookie or Bearer) → API token (Bearer with sb_ prefix).
 * If JWT fails and Bearer token starts with sb_, tries API token lookup.
 */
export function requireAuth(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: false }, async (err: any, user: any) => {
      if (err) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (user) {
        (req as AuthRequest).user = user;
        return next();
      }
      // JWT failed; try API token if Bearer header present
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith('sb_')) {
          const apiUser = await validateToken(token);
          if (apiUser) {
            (req as AuthRequest).user = apiUser;
            return next();
          }
        }
      }
      return res.status(401).json({ error: 'Unauthorized' });
    })(req, res, next);
  };
}

/**
 * Attach req.user when JWT or API token is valid; otherwise continue without user.
 * Used before cloud tenant middleware so session.organizationId can be reconciled with the authenticated user.
 */
export function optionalAttachUser(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: false }, async (err: any, user: any) => {
      if (err) {
        return next(err);
      }
      if (user) {
        (req as AuthRequest).user = user;
        return next();
      }
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith('sb_')) {
          const apiUser = await validateToken(token);
          if (apiUser) {
            (req as AuthRequest).user = apiUser;
            return next();
          }
        }
      }
      // Cloud: without JWT/API auth, ignore Passport-deserialized user (stale session after logout
      // or JWT cleared). OIDC callback must keep session-backed flow intact.
      if (isCloudRuntime) {
        const path = req.path || '';
        const isOidcCallback = /\/auth\/[^/]+\/callback$/.test(path);
        const hasJwtCookieOrBearer = Boolean(extractTokenFromRequest(req));
        if (!isOidcCallback && !hasJwtCookieOrBearer) {
          delete (req as AuthRequest).user;
        }
      }
      next();
    })(req, res, next);
  };
}

/**
 * Middleware to authenticate and require global admin.
 * Supports JWT and API token same as requireAuth.
 */
export function requireAdmin(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: false }, async (err: any, user: any) => {
      if (err) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!user) {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.substring(7);
          if (token.startsWith('sb_')) {
            user = await validateToken(token);
          }
        }
      }
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const isGlobalAdmin = user.is_admin === true || user.is_admin === 1;
      if (!isGlobalAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      (req as AuthRequest).user = user;
      next();
    })(req, res, next);
  };
}
