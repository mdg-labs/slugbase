import type { Request } from 'express';

export const DEFAULT_TENANT_ID = 'default';

export function getDefaultTenantId(): string {
  return DEFAULT_TENANT_ID;
}

export function getTenantId(req: Request): string {
  const tenantId = (req as Request & { tenantId?: string }).tenantId;
  if (!tenantId) {
    throw new Error('Missing tenantId on request');
  }
  return tenantId;
}
