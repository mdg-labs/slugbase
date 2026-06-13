import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

/** Named member group within a workspace used as a sharing target (spec §10.1, §16). */
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("teams_workspace_id_idx").on(t.workspaceId),
    index("teams_workspace_name_idx").on(t.workspaceId, t.name),
  ],
);
