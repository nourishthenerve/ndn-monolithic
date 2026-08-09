import { describe, expect, it } from 'vitest';

import {
  findForbiddenDisableComments,
  isForbiddenDisableDirective,
} from './disable-comment-guard.js';

describe('isForbiddenDisableDirective', () => {
  it('allows a directive naming only unrelated rules', () => {
    expect(isForbiddenDisableDirective('no-unused-vars')).toBe(false);
    expect(isForbiddenDisableDirective('@typescript-eslint/no-explicit-any')).toBe(false);
  });

  it('forbids a directive naming this rule, alone or alongside others', () => {
    expect(isForbiddenDisableDirective('ndn/no-destructive-primitives')).toBe(true);
    expect(isForbiddenDisableDirective('no-unused-vars, ndn/no-destructive-primitives')).toBe(true);
  });

  it('forbids a bare directive with no rule list (suppresses every rule)', () => {
    expect(isForbiddenDisableDirective('')).toBe(true);
    expect(isForbiddenDisableDirective(undefined)).toBe(true);
  });
});

describe('findForbiddenDisableComments', () => {
  it('finds nothing in source with no directives, or only unrelated ones', () => {
    expect(findForbiddenDisableComments('const x = 1;')).toEqual([]);
    expect(findForbiddenDisableComments('// this deletes nothing\nconst x = 1;')).toEqual([]);
    expect(
      findForbiddenDisableComments('// eslint-disable-next-line no-unused-vars\nconst x = 1;'),
    ).toEqual([]);
  });

  it('flags eslint-disable-next-line targeting this rule', () => {
    const violations = findForbiddenDisableComments(
      '// eslint-disable-next-line ndn/no-destructive-primitives\nnew DeleteObjectCommand({});',
    );
    expect(violations).toEqual([
      { line: 1, text: '// eslint-disable-next-line ndn/no-destructive-primitives' },
    ]);
  });

  it('flags eslint-disable-line targeting this rule', () => {
    const violations = findForbiddenDisableComments(
      'new DeleteObjectCommand({}); // eslint-disable-line ndn/no-destructive-primitives',
    );
    expect(violations).toEqual([
      {
        line: 1,
        text: 'new DeleteObjectCommand({}); // eslint-disable-line ndn/no-destructive-primitives',
      },
    ]);
  });

  it('flags a block-level eslint-disable naming this rule', () => {
    const violations = findForbiddenDisableComments(
      '/* eslint-disable ndn/no-destructive-primitives */',
    );
    expect(violations).toHaveLength(1);
  });

  it('flags a bare eslint-disable with no rule list, line or block form', () => {
    expect(findForbiddenDisableComments('// eslint-disable')).toHaveLength(1);
    expect(findForbiddenDisableComments('/* eslint-disable */')).toHaveLength(1);
  });

  it('reports correct line numbers across a multi-line file with a mix', () => {
    const source = [
      'const a = 1;',
      '// eslint-disable-next-line no-unused-vars',
      'const b = 2;',
      '// eslint-disable-next-line ndn/no-destructive-primitives',
      'new DeleteObjectCommand({});',
    ].join('\n');
    const violations = findForbiddenDisableComments(source);
    expect(violations).toEqual([
      { line: 4, text: '// eslint-disable-next-line ndn/no-destructive-primitives' },
    ]);
  });
});
