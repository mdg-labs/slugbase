import { eq } from "drizzle-orm";

import type { DrizzleClient } from "./dialect/create-client.js";
import { instanceMetadata } from "./schema/index.js";

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
}
