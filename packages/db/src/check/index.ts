import { checksumsRule } from "./checksums.ts";
import { customSqlRule } from "./custom-sql.ts";
import { driftRule } from "./drift.ts";
import { expandContractRule } from "./expand-contract.ts";
import { ownershipRule } from "./ownership.ts";
import { purgeRegistryRule } from "./purge-registry.ts";
import { rlsRule } from "./rls.ts";
import { systemOperationsRule } from "./system-operations.ts";
import type { CheckRule } from "./types.ts";

export { contractMarkerFromEnv } from "./expand-contract.ts";
export { formatReport, runChecks } from "./run.ts";
export { recordChecksums } from "./migration-files.ts";
export type { CheckContext, CheckRule, ContractMarker, Finding, RuleResult } from "./types.ts";

/** The rules `pnpm db:check` runs, in the order it reports them. A new rule is added here. */
export const checkRules: readonly CheckRule[] = [rlsRule, ownershipRule, checksumsRule, driftRule, customSqlRule, systemOperationsRule, purgeRegistryRule, expandContractRule];
