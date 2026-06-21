import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import { AdminSessionService } from "../auth/session.service.js";
import { ProductReadService } from "../stats/product-read.service.js";
import { MetricsHistoryService } from "../stats/metrics-history.service.js";

export interface DirectoryRouteDeps {
  adminDb: AdminDb;
  config: AdminEnv;
  sessions?: AdminSessionService;
  productRead?: ProductReadService;
  metricsHistory?: MetricsHistoryService;
}

export function createDirectoryRouteDeps(deps: DirectoryRouteDeps) {
  const sessions = deps.sessions ?? new AdminSessionService(deps.adminDb, deps.config);
  const productRead =
    deps.productRead ?? new ProductReadService(deps.config.DATABASE_URL);
  const metricsHistory =
    deps.metricsHistory ?? new MetricsHistoryService(deps.adminDb);

  return {
    sessions,
    productRead,
    metricsHistory,
  };
}
