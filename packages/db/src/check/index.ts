import { checksumsRule } from "./checksums.ts";
import { customSqlRule } from "./custom-sql.ts";
import { driftRule } from "./drift.ts";
import { ownershipRule } from "./ownership.ts";
import { rlsRule } from "./rls.ts";
import { systemOperationsRule } from "./system-operations.ts";
import type { CheckRule } from "./types.ts";

export { formatReport, runChecks } from "./run.ts";
export { recordChecksums } from "./migration-files.ts";
export type { CheckContext, CheckRule, Finding, RuleResult } from "./types.ts";

/** The rules `pnpm db:check` runs, in the order it reports them. A new rule is added here. */
export const checkRules: readonly CheckRule[] = [rlsRule, ownershipRule, checksumsRule, driftRule, customSqlRule, systemOperationsRule];
