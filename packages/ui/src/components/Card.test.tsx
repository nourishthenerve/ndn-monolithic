// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Card } from './Card.js';

afterEach(cleanup);
describe('Card', () => {
  it('renders a semantic <article>, not a generic <div>', () => {
    const { getByRole } = render(<Card>Content</Card>);
    expect(getByRole('article').tagName).toBe('ARTICLE');
  });

  it('forwards className and other props', () => {
    const { getByRole } = render(
      <Card className="extra" aria-label="Workshop">
        Content
      </Card>,
    );
    const el = getByRole('article', { name: 'Workshop' });
    expect(el).toHaveClass('ndn-card');
    expect(el).toHaveClass('extra');
  });
});
