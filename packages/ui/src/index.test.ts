import { describe, expect, it } from 'vitest';

import {
  Button,
  Card,
  colorTokens,
  Heading,
  Input,
  Link,
  minInteractiveTargetPx,
  SkipLink,
  VisuallyHidden,
} from './index.js';

describe('@ndn/ui public surface', () => {
  it('exports every Phase 1.1.1 primitive and token module', () => {
    expect(Button).toBeTypeOf('function');
    expect(Link).toBeTypeOf('function');
    expect(Input).toBeTypeOf('function');
    expect(Heading).toBeTypeOf('function');
    expect(Card).toBeTypeOf('function');
    expect(SkipLink).toBeTypeOf('function');
    expect(VisuallyHidden).toBeTypeOf('function');
    expect(colorTokens.text).toBeDefined();
    expect(minInteractiveTargetPx).toBe(24);
  });
});
