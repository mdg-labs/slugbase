import { basename } from "node:path";
import type { AST, ESLint, Linter, Rule } from "eslint";
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
// justifications. A report of either vocabulary rule suppressed by a directive
// with no justification is turned back into an error, whatever rules the
// directive names.
const requireJustifiedSuppression: Linter.Processor = {
  meta: { name: "slugbase-vocabulary-suppression" },
  supportsAutofix: true,
  preprocess: (text) => [text],
  postprocess: (messageLists) =>
    messageLists.flat().map((message): Linter.LintMessage => {
      // The processor type lists plain messages; ESLint passes suppressed ones
      // too, with their suppressions attached.
      const { suppressions, ...active } = message as Partial<Linter.SuppressedLintMessage> & Linter.LintMessage;
      const unjustified =
        (message.ruleId === FORBIDDEN_RULE || message.ruleId === REASON_RULE) &&
        (suppressions ?? []).some(
          (suppression) => suppression.kind === "directive" && suppression.justification.trim() === "",
        );
      if (!unjustified) {
        return message;
      }
      return {
        ...active,
        message:
          message.ruleId === FORBIDDEN_RULE
            ? `${message.message} The disable directive covering it has no reason after " -- ".`
            : message.message,
      };
    }),
};

export const vocabularyPlugin: ESLint.Plugin = {
  meta: { name: "slugbase-vocabulary" },
  processors: { vocabulary: requireJustifiedSuppression },
  rules: {
    "no-forbidden-vocabulary": noForbiddenVocabulary,
    "vocabulary-disable-reason": requireDisableReason,
  },
};
