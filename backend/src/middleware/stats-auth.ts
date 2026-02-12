/**
 * Secret-based auth for stats endpoint.
 * Uses X-Stats-Secret header; constant-time comparison; returns 404 on invalid (no info leak).
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function statsSecretAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.STATS_ENDPOINT_SECRET?.trim();
  if (!secret) {
    res.status(404).end();
    return;
  }

  const headerSecret = req.headers['x-stats-secret'];
  const provided = typeof headerSecret === 'string' ? headerSecret : '';

  if (provided.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'))) {
    res.status(404).end();
    return;
  }

  next();
}
