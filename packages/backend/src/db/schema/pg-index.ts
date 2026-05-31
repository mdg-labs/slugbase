import { apiTokens } from "./api-token.schema.pg.js";
import { mfaBackupCodes } from "./mfa-backup-code.schema.pg.js";
import { instanceMetadata } from "./system.schema.pg.js";
import { sessions } from "./session.schema.pg.js";
import { userAccounts } from "./user-account.schema.pg.js";

export { apiTokens } from "./api-token.schema.pg.js";
export { mfaBackupCodes } from "./mfa-backup-code.schema.pg.js";
export { instanceMetadata } from "./system.schema.pg.js";
export { sessions } from "./session.schema.pg.js";
export { userAccounts } from "./user-account.schema.pg.js";

export const pgSchema = {
  instanceMetadata,
  apiTokens,
  mfaBackupCodes,
  sessions,
  userAccounts,
};

export type PgAppSchema = typeof pgSchema;
