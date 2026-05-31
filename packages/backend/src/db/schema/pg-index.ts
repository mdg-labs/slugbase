import { instanceMetadata } from "./system.schema.pg.js";
import { sessions } from "./session.schema.pg.js";

export { instanceMetadata } from "./system.schema.pg.js";
export { sessions } from "./session.schema.pg.js";

export const pgSchema = {
  instanceMetadata,
  sessions,
};

export type PgAppSchema = typeof pgSchema;
