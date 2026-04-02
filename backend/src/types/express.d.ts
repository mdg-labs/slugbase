import 'express-serve-static-core';
import 'express-session';

declare module 'express-serve-static-core' {
  interface Request {
    tenantId?: string;
  }
}

declare module 'express-session' {
  interface SessionData {
    organizationId?: string;
    tenantId?: string;
  }
}
