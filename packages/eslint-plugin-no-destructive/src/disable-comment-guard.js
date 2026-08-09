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

import { FULL_RULE_ID } from './constants.js';

const DIRECTIVE_LINE = /(?:\/\/|\/\*)\s*(eslint-disable(?:-next-line|-line)?)\b([^*\r\n]*)/;

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

/** @param {string} sourceText */
export function findForbiddenDisableComments(sourceText) {
  const violations = [];
  const lines = sourceText.split(/\r\n|\r|\n/);
  for (const [index, line] of lines.entries()) {
    const match = DIRECTIVE_LINE.exec(line);
    if (match && isForbiddenDisableDirective(match[2])) {
      violations.push({ line: index + 1, text: line.trim() });
    }
  }
  return violations;
}
