import type { CheckContext, CheckRule, Finding, RuleResult } from "./types.ts";

/**
 * Runs every rule. A rule that throws did not check anything, so it yields a
 * finding of its own: an error in a check means "not safe", never "fine".
 */
export async function runChecks(rules: readonly CheckRule[], context: CheckContext): Promise<RuleResult[]> {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    let findings: readonly Finding[];
    try {
      findings = await rule.run(context);
    } catch (error) {
      findings = [
        {
          rule: rule.id,
          object: rule.id,
          message: `the rule could not run: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      ];
    }
    results.push({ rule: rule.id, description: rule.description, findings });
  }
  return results;
}

/** The lines `pnpm db:check` prints, and whether it passed: it passes when no rule has a finding. */
export function formatReport(results: readonly RuleResult[]): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let failed = 0;
  for (const result of results) {
    if (result.findings.length === 0) {
      lines.push(`db:check: ok    ${result.rule}`);
      continue;
    }
    failed += 1;
    for (const finding of result.findings) {
      lines.push(`db:check: FAIL  ${finding.rule}: ${finding.object}: ${finding.message}`);
    }
  }
  const total = String(results.length);
  lines.push(failed > 0 ? `db:check: ${String(failed)} of ${total} rule(s) failed` : `db:check: ${total} rule(s) passed`);
  return { passed: failed === 0, lines };
}
