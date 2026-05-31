import { instanceMetadata } from "../system.schema.js";
import { mfaBackupCodes } from "./mfa-backup-code.schema.js";
import { sessions } from "./session.schema.js";
import { userAccounts } from "./user-account.schema.js";

export { instanceMetadata } from "../system.schema.js";
export { mfaBackupCodes } from "./mfa-backup-code.schema.js";
export { sessions } from "./session.schema.js";
export { userAccounts } from "./user-account.schema.js";

export const schema = {
  instanceMetadata,
  mfaBackupCodes,
  sessions,
  userAccounts,
};

export type AppSchema = typeof schema;
