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

/**
 * The lines `pnpm db:check` prints, and whether it passed. A finding that only awaits the
 * `migration:contract` label is shown as AWAIT and does not fail the run, but the summary then
 * does not say the rule passed.
 */
export function formatReport(results: readonly RuleResult[]): { passed: boolean; lines: string[] } {
  const lines: string[] = [];
  let failed = 0;
  let awaiting = 0;
  for (const result of results) {
    if (result.findings.length === 0) {
      lines.push(`db:check: ok    ${result.rule}`);
      continue;
    }
    let failing = false;
    for (const finding of result.findings) {
      if (finding.awaiting === true) {
        lines.push(`db:check: AWAIT ${finding.rule}: ${finding.object}: ${finding.message}`);
      } else {
        failing = true;
        lines.push(`db:check: FAIL  ${finding.rule}: ${finding.object}: ${finding.message}`);
      }
    }
    if (failing) {
      failed += 1;
    } else {
      awaiting += 1;
    }
  }
  const total = String(results.length);
  if (failed > 0) {
    lines.push(`db:check: ${String(failed)} of ${total} rule(s) failed`);
  } else if (awaiting > 0) {
    lines.push(
      `db:check: ${String(results.length - awaiting)} of ${total} rule(s) passed, ${String(awaiting)} awaiting the migration:contract label: not accepted until the run of a pull request that carries it passes`,
    );
  } else {
    lines.push(`db:check: ${total} rule(s) passed`);
  }
  return { passed: failed === 0, lines };
}
