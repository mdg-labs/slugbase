import { basename } from "node:path";
import type { AST, ESLint, Linter, Rule } from "eslint";
import { boundaryRules, hasIssueLink, UNSAFE_HTML_RULE, unsafeHtmlConfigComments } from "../boundaries/eslint-plugin.ts";
import { findTerm, loadTerms, type ForbiddenTerm } from "./terms.ts";

export const FORBIDDEN_RULE = "slugbase/no-forbidden-vocabulary";
const REASON_RULE = "slugbase/vocabulary-disable-reason";

interface NamedNode {
  name: string;
  parent?: { type: string; property?: unknown; right?: unknown; computed?: boolean };
}

function message(name: string, term: ForbiddenTerm): string {
  return `"${name}" contains "${term.word}"; the product term is "${term.canonical}" (doc 00 section 3). A third-party name that cannot be renamed needs an eslint-disable comment with a reason after " -- ".`;
}

const noForbiddenVocabulary: Rule.RuleModule = {
  meta: { type: "problem", schema: [], messages: { forbidden: "{{ text }}" } },
  create(context) {
    const terms = loadTerms();
    const reported = new Set<string>();
    const report = (name: string, term: ForbiddenTerm, loc: AST.SourceLocation | { line: number; column: number }, key: string): void => {
      if (reported.has(key)) {
        return;
      }
      reported.add(key);
      context.report({ loc, messageId: "forbidden", data: { text: message(name, term) } });
    };

    const checkIdentifier = (node: Rule.Node): void => {
      const { name, parent } = node as unknown as NamedNode;
      // The definition site is where a name is chosen; reading a member of
      // something else is not a naming decision.
      if (parent?.property === node && parent.computed !== true) {
        return;
      }
      if (parent?.type === "TSQualifiedName" && parent.right === node) {
        return;
      }
      const term = findTerm(name, terms);
      if (term !== undefined && node.loc != null) {
        const { line, column } = node.loc.start;
        report(name, term, node.loc, `${String(line)}:${String(column)}`);
      }
    };

    return {
      Program() {
        const file = basename(context.filename);
        const term = findTerm(file, terms);
        if (term !== undefined) {
          report(file, term, { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } }, "file");
        }
      },
      Identifier: checkIdentifier,
      PrivateIdentifier: checkIdentifier,
      JSXIdentifier: checkIdentifier,
    };
  },
};

const DIRECTIVE = /^\s*eslint-disable(?:-next-line|-line)?(?=\s|$)([\s\S]*)$/;

// Suppressing the vocabulary rule is allowed only with a reason, so the
// directive's description ("-- reason") must be present. A directive that names
// other rules only is none of this rule's business. The report lands on the
// directive itself, where a blanket directive can suppress it; the processor
// below turns such a suppressed report back into an error.
const requireDisableReason: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      reason: `A directive that disables ${FORBIDDEN_RULE} needs a reason after " -- ".`,
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = DIRECTIVE.exec(comment.value);
          if (match === null) {
            continue;
          }
          const [rulesPart = "", ...description] = (match[1] ?? "").split(/\s--\s/);
          const named = rulesPart.split(",").map((rule) => rule.trim()).filter((rule) => rule !== "");
          const covers = named.length === 0 || named.includes(FORBIDDEN_RULE);
          if (covers && description.join(" -- ").trim() === "") {
            context.report({ loc: comment.loc ?? { line: 1, column: 0 }, messageId: "reason" });
          }
        }
      },
    };
  },
};

// ESLint hands a processor's postprocess every report, the suppressed ones
// included, each marked with the directives that suppress it and their
// justifications. A report of a guarded rule suppressed by a directive whose
// justification does not satisfy the rule's condition is turned back into an
// error, whatever rules the directive names. The vocabulary rules need a
// reason; the unsafe-HTML rule needs an issue link.
const GUARDED_SUPPRESSIONS: ReadonlyMap<string, { accepts: (justification: string) => boolean; hint: string }> =
  new Map([
    [FORBIDDEN_RULE, { accepts: (text) => text.trim() !== "", hint: "has no reason after \" -- \"" }],
    [REASON_RULE, { accepts: (text) => text.trim() !== "", hint: "" }],
    [UNSAFE_HTML_RULE, { accepts: hasIssueLink, hint: "has no issue link (such as #123) after \" -- \"" }],
  ]);

// An inline configuration comment can turn a rule off before it runs, so the
// processor reads the text itself for the unsafe-HTML rule and reports every
// such comment that lacks an issue link.
const sources = new Map<string, string>();

const requireJustifiedSuppression: Linter.Processor = {
  meta: { name: "slugbase-vocabulary-suppression" },
  supportsAutofix: true,
  preprocess: (text, filename) => {
    sources.set(filename, text);
    return [text];
  },
  postprocess: (messageLists, filename) => {
    const text = sources.get(filename);
    sources.delete(filename);
    const inlineConfig = unsafeHtmlConfigComments(text ?? "", filename).map(
      ({ line, column }): Linter.LintMessage => ({
        ruleId: UNSAFE_HTML_RULE,
        severity: 2,
        line,
        column,
        message: `Inline configuration of ${UNSAFE_HTML_RULE} is accepted only with an issue link (such as #123) after " -- ".`,
      }),
    );
    return [...inlineConfig, ...guardSuppressions(messageLists)];
  },
};

function guardSuppressions(messageLists: Linter.LintMessage[][]): Linter.LintMessage[] {
  return messageLists.flat().map((message): Linter.LintMessage => {
    // The processor type lists plain messages; ESLint passes suppressed ones
    // too, with their suppressions attached.
    const { suppressions, ...active } = message as Partial<Linter.SuppressedLintMessage> & Linter.LintMessage;
    const guard = message.ruleId === null ? undefined : GUARDED_SUPPRESSIONS.get(message.ruleId);
    const unjustified =
      guard !== undefined &&
      (suppressions ?? []).some(
        (suppression) => suppression.kind === "directive" && !guard.accepts(suppression.justification),
      );
    if (guard === undefined || !unjustified) {
      return message;
    }
    return {
      ...active,
      message: guard.hint === "" ? message.message : `${message.message} The disable directive covering it ${guard.hint}.`,
    };
  });
}

// The one `slugbase` plugin: the vocabulary rules and the boundary rules share
// its suppression processor, because a file takes a single processor.
export const vocabularyPlugin: ESLint.Plugin = {
  meta: { name: "slugbase-vocabulary" },
  processors: { vocabulary: requireJustifiedSuppression },
  rules: {
    "no-forbidden-vocabulary": noForbiddenVocabulary,
    "vocabulary-disable-reason": requireDisableReason,
    ...boundaryRules,
  },
};
