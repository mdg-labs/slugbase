import { adminUsers } from "@slugbase/db-admin/schema";
import { count } from "drizzle-orm";

import type { AdminEnv } from "../config/env.schema.js";
import type { AdminDb } from "../db/create-db.js";
import { AdminPasswordService } from "./password.service.js";

export class AdminBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminBootstrapError";
  }
}

export async function bootstrapAdminIfNeeded(
  adminDb: AdminDb,
  config: AdminEnv,
  passwords: AdminPasswordService = new AdminPasswordService(),
): Promise<void> {
  const [countRow] = await adminDb.db
    .select({ value: count() })
    .from(adminUsers);

  const userCount = countRow?.value ?? 0;

  const hasBootstrapCredentials =
    config.ADMIN_BOOTSTRAP_EMAIL !== undefined &&
    config.ADMIN_BOOTSTRAP_PASSWORD !== undefined;

  if (userCount > 0) {
    if (hasBootstrapCredentials) {
      throw new AdminBootstrapError(
        "Admin users already exist; remove ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD",
      );
    }
    return;
  }

  if (!hasBootstrapCredentials) {
    throw new AdminBootstrapError(
      "ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required when no admin users exist",
    );
  }

  const bootstrapEmail = config.ADMIN_BOOTSTRAP_EMAIL;
  const bootstrapPassword = config.ADMIN_BOOTSTRAP_PASSWORD;
  if (!bootstrapEmail || !bootstrapPassword) {
    throw new AdminBootstrapError(
      "ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required when no admin users exist",
    );
  }

  const passwordHash = await passwords.hashPassword(bootstrapPassword);

  await adminDb.db.insert(adminUsers).values({
    email: bootstrapEmail.toLowerCase(),
    passwordHash,
    role: "platform_admin",
  });
}
