import { instanceMetadata } from "../system.schema.js";
import { sessions } from "./session.schema.js";
import { userAccounts } from "./user-account.schema.js";

export { instanceMetadata } from "../system.schema.js";
export { sessions } from "./session.schema.js";
export { userAccounts } from "./user-account.schema.js";

export const schema = {
  instanceMetadata,
  sessions,
  userAccounts,
};

export type AppSchema = typeof schema;
