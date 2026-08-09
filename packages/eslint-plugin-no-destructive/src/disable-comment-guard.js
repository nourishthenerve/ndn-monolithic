// Deliberately NOT an ESLint rule. ESLint's own directive engine filters the
// final message list by ruleId+range *before* CI ever sees it — a rule that
// tries to police "don't disable me" reports would have its own report
// silently dropped by a bare `/* eslint-disable */` (which suppresses every
// rule, including itself) or by `/* eslint-disable ndn/no-destructive-primitives */`
// (which suppresses that exact ruleId, including a self-referential report
// under the same id). Scanning source text directly, outside the linter,
// sidesteps that suppression entirely — nothing short of deleting or editing
// this script can silence it, which is the point of the DoD's "Do NOT: allow
// per-file disable comments for this rule".

import ts from 'typescript';

import { FULL_RULE_ID } from './constants.js';

// A directive comment's body — after stripping `//`/`/* */` — starts with
// this; anchored to the start so prose that merely *mentions* eslint-disable
// syntax (this file's own header, above) doesn't match.
const DIRECTIVE_PREFIX = /^(eslint-disable(?:-next-line|-line)?)\b(.*)$/s;

/**
 * A bare directive (no rule list) suppresses every rule, including ours.
 * @param {string | undefined} ruleListText
 * @returns {boolean}
 */
export function isForbiddenDisableDirective(ruleListText) {
  const ruleList = (ruleListText ?? '').trim();
  if (ruleList === '') {
    return true;
  }
  return ruleList
    .split(',')
    .map((/** @type {string} */ entry) => entry.trim())
    .includes(FULL_RULE_ID);
}

/** @param {string} rawComment */
function stripCommentMarkers(rawComment) {
  if (rawComment.startsWith('//')) {
    return rawComment.slice(2).trim();
  }
  return rawComment.slice(2, -2).trim();
}

/**
 * Real comments only, via the TypeScript scanner — not ESLint's own linter
 * (see the module header for why), and not a naive text/line regex either:
 * a regex matching "eslint-disable" anywhere in a line would also match
 * this file's own explanatory prose and the string-literal test fixtures
 * in disable-comment-guard.test.js, both of which *describe* the syntax
 * without being real directives. The scanner tokenizes string/template
 * literals correctly, so their contents are never mistaken for comments.
 * @param {string} sourceText
 */
export function findForbiddenDisableComments(sourceText) {
  const violations = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText,
  );
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const raw = scanner.getTokenText();
      const match = DIRECTIVE_PREFIX.exec(stripCommentMarkers(raw));
      if (match && isForbiddenDisableDirective(match[2])) {
        const line = sourceText.slice(0, scanner.getTokenStart()).split(/\r\n|\r|\n/).length;
        const [firstLine] = raw.split(/\r\n|\r|\n/);
        violations.push({ line, text: (firstLine ?? raw).trim() });
      }
    }
    kind = scanner.scan();
  }
  return violations;
}
