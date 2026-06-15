import { eq } from "drizzle-orm";

import type { DrizzleClient } from "./dialect/create-client.js";
import { instanceMetadata } from "./schema/index.js";

/** Written while setup is in flight; upgraded to {@link SETUP_COMPLETE_VALUE} on success. */
export const SETUP_IN_PROGRESS_VALUE = "in_progress";
export const SETUP_COMPLETE_VALUE = "true";

export class InstanceMetadataRepository {
  constructor(private readonly db: DrizzleClient) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: instanceMetadata.value })
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, key));

    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const updatedAt = Date.now();

    await this.db
      .insert(instanceMetadata)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: instanceMetadata.key,
        set: { value, updatedAt },
      });
  }

  /**
   * Atomically claims first-time setup. Returns false when setup is already
   * complete or another request holds the in-progress claim.
   */
  async tryClaimSetupCompletion(key: string): Promise<boolean> {
    const updatedAt = Date.now();
    const rows = await this.db
      .insert(instanceMetadata)
      .values({ key, value: SETUP_IN_PROGRESS_VALUE, updatedAt })
      .onConflictDoNothing()
      .returning({ key: instanceMetadata.key });

    return rows.length > 0;
  }

  async releaseSetupCompletionClaim(key: string): Promise<void> {
    await this.db
      .delete(instanceMetadata)
      .where(eq(instanceMetadata.key, key));
  }
}
