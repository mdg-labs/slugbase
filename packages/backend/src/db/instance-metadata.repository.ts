import { eq } from "drizzle-orm";

import type { DrizzleClient } from "./dialect/create-client.js";
import { instanceMetadata } from "./schema/index.js";

export class InstanceMetadataRepository {
  constructor(private readonly db: DrizzleClient) {}

  get(key: string): Promise<string | null> {
    const row = this.db
      .select({ value: instanceMetadata.value })
      .from(instanceMetadata)
      .where(eq(instanceMetadata.key, key))
      .get();

    return Promise.resolve(row?.value ?? null);
  }

  set(key: string, value: string): Promise<void> {
    const updatedAt = new Date();

    this.db
      .insert(instanceMetadata)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({
        target: instanceMetadata.key,
        set: { value, updatedAt },
      })
      .run();

    return Promise.resolve();
  }
}
