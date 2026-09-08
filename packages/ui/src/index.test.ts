import { describe, expect, it } from 'vitest';

import {
  Button,
  Card,
  colorTokens,
  Heading,
  Input,
  Link,
  Loading,
  minInteractiveTargetPx,
  Skeleton,
  SkipLink,
  Spinner,
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

  // 2026-09-08: the waiting primitives. Exported from the package root
  // rather than reached into by subpath, like everything else here — the
  // `exports` map declares no subpath at all.
  it('exports the waiting primitives the account panels are built on', () => {
    expect(Loading).toBeTypeOf('function');
    expect(Spinner).toBeTypeOf('function');
    expect(Skeleton).toBeTypeOf('function');
  });
});
