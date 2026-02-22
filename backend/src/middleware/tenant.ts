import type { Request, Response, NextFunction } from 'express';
import { DEFAULT_TENANT_ID } from '../utils/tenant.js';

export function tenantMiddleware(req: Request, _res: Response, next: NextFunction): void {
  let tenantId = DEFAULT_TENANT_ID;

  if (process.env.NODE_ENV === 'test') {
    const testTenant = req.header('x-test-tenant')?.trim();
    if (testTenant) {
      tenantId = testTenant;
    }
  }

  (req as Request & { tenantId?: string }).tenantId = tenantId;
  next();
}
