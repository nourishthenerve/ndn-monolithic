import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';
import { healthResponseSchema } from './health-contract.js';

// TASK 0.6.3: D-19's "contract tests" — proves /health's response *shape*
// is stable, not just that it returns 200 (integration.test.ts covers
// that). A field silently renamed or dropped fails here even though the
// status code stays 200.
describe('ephemeral PR environment — contract', () => {
  it('/health matches the documented response contract', async () => {
    const response = await fetch(`${getBaseUrl()}/health`);
    const body: unknown = await response.json();

    const result = healthResponseSchema.safeParse(body);

    expect(result.success, result.success ? '' : JSON.stringify(result.error?.issues)).toBe(true);
  });
});
