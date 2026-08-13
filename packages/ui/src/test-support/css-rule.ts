import { expect } from 'vitest';

/** Extracts a CSS rule's declaration body by selector, for tests that assert against source text rather than jsdom's partial `:focus-visible`/cascade support. */
export function getCssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.:[\]]/g, (char) => `\\${char}`);
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `expected a CSS rule for selector "${selector}"`).not.toBeNull();
  return match?.[1] ?? '';
}
