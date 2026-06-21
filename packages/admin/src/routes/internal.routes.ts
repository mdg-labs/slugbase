import { Hono } from "hono";
import { z } from "zod";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import {
  createRequireAdminAuth,
  createRequireAdminRole,
  type AdminAuthVariables,
} from "../auth/auth.middleware.js";
import { AdminSessionService } from "../auth/session.service.js";
import { createSnapshotJob } from "../jobs/snapshot.job.js";
import { priorUtcDate } from "../jobs/snapshot-rollup.js";

const snapshotBodySchema = z
  .object({
    snapshotDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export interface InternalRouteDeps {
  adminDb: AdminDb;
  config: AdminEnv;
  sessions?: AdminSessionService;
}

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AdminAuthVariables }> {
  const sessions = deps.sessions ?? new AdminSessionService(deps.adminDb, deps.config);
  const requireAuth = createRequireAdminAuth(sessions);
  const requirePlatformAdmin = createRequireAdminRole("platform_admin");
  const snapshotJob = createSnapshotJob(deps.adminDb, deps.config.DATABASE_URL);

  const routes = new Hono<{ Variables: AdminAuthVariables }>();

  routes.post("/snapshot", requireAuth, requirePlatformAdmin, async (c) => {
    let rawBody: unknown = {};
    try {
      rawBody = await c.req.json();
    } catch {
      rawBody = {};
    }
    const parsed = snapshotBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const snapshotDate = parsed.data.snapshotDate ?? priorUtcDate();
    const snapshot = await snapshotJob.run(snapshotDate);

    return c.json({ snapshot }, 200);
  });

  return routes;
}
