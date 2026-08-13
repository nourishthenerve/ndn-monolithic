import { describe, expect, it } from 'vitest';

import { getCssRuleBody } from './css-rule.js';

describe('getCssRuleBody', () => {
  it('extracts the declaration body for a matching selector', () => {
    const body = getCssRuleBody('.foo { color: red; }', '.foo');
    expect(body).toContain('color: red;');
  });

  it('fails the assertion for a selector with no matching rule', () => {
    expect(() => getCssRuleBody('.foo { color: red; }', '.bar')).toThrow();
  });
});
