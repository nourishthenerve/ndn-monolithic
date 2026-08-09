#!/usr/bin/env node
// Authoritative backstop for TASK 0.3.1's "Do NOT: allow per-file disable
// comments for this rule". Deliberately a plain text scan, not an ESLint
// rule — see the comment atop disable-comment-guard.js for why an ESLint
// rule can't be made to reliably police disable comments about itself.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { findForbiddenDisableComments } from '@ndn/eslint-plugin-no-destructive';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

function listTrackedSourceFiles() {
  const output = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return output
    .split('\n')
    .filter((path) => path !== '')
    .filter((path) => SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.'))));
}

let violationCount = 0;

for (const file of listTrackedSourceFiles()) {
  const source = readFileSync(file, 'utf8');
  for (const violation of findForbiddenDisableComments(source)) {
    violationCount += 1;
    console.error(`${file}:${violation.line}: ${violation.text}`);
  }
}

if (violationCount > 0) {
  console.error(
    `\n${violationCount} disable-comment violation(s) found. ` +
      'ndn/no-destructive-primitives may not be suppressed inline (docs/plan/05-execution-plan.md TASK 0.3.1).',
  );
  process.exit(1);
}
