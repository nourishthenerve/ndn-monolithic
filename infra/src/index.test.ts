import { describe, expect, it } from 'vitest';

import { placeholder } from './index.js';

describe('placeholder', () => {
  it('proves the test harness runs', () => {
    expect(placeholder()).toBe('@ndn/infra');
  });
});
