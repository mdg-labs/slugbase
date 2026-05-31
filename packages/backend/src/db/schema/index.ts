import { instanceMetadata } from "../system.schema.js";
import { sessions } from "./session.schema.js";

export { instanceMetadata } from "../system.schema.js";
export { sessions } from "./session.schema.js";

export const schema = {
  instanceMetadata,
  sessions,
};

export type AppSchema = typeof schema;
