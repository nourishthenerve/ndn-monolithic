// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Heading } from './Heading.js';

afterEach(cleanup);
describe('Heading', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)('level %i renders an <h%i>', (level) => {
    const { getByRole } = render(<Heading level={level}>Title</Heading>);
    const el = getByRole('heading', { level });
    expect(el.tagName).toBe(`H${level}`);
  });

  it('forwards className alongside the built-in class', () => {
    const { getByRole } = render(
      <Heading level={2} className="extra">
        Title
      </Heading>,
    );
    const el = getByRole('heading', { level: 2 });
    expect(el).toHaveClass('ndn-heading');
    expect(el).toHaveClass('extra');
  });
});
