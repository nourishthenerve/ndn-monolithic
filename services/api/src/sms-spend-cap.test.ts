import { describe, expect, it } from 'vitest';

import {
  currentMonthKey,
  InMemorySpendCounterStore,
  SMS_MONTHLY_CAP_PENCE,
} from './sms-spend-cap.js';

describe('currentMonthKey', () => {
  it('formats as YYYY-MM, UTC, zero-padded', () => {
    expect(currentMonthKey(new Date('2026-08-10T23:00:00.000Z'))).toBe('2026-08');
    expect(currentMonthKey(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01');
  });
});

describe('InMemorySpendCounterStore', () => {
  it('commits an add that lands exactly on the cap (£5.00 boundary)', async () => {
    const store = new InMemorySpendCounterStore();
    await expect(store.tryAdd('2026-08', 500, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);
  });

  it('commits an add one penny under the cap (£4.99 boundary)', async () => {
    const store = new InMemorySpendCounterStore();
    await expect(store.tryAdd('2026-08', 499, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);
  });

  it('rejects an add one penny over the cap (£5.01 boundary) and applies nothing', async () => {
    const store = new InMemorySpendCounterStore();
    await expect(store.tryAdd('2026-08', 501, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(false);
    // Rejected adds never partially apply — a follow-up add for the full
    // cap must still succeed against an untouched counter.
    await expect(store.tryAdd('2026-08', 500, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);
  });

  it('accumulates across calls and blocks only once the running total would exceed the cap', async () => {
    const store = new InMemorySpendCounterStore();
    await expect(store.tryAdd('2026-08', 499, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);
    await expect(store.tryAdd('2026-08', 1, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true); // now exactly 500
    await expect(store.tryAdd('2026-08', 1, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(false); // would be 501
  });

  it('keeps independent totals per month key', async () => {
    const store = new InMemorySpendCounterStore();
    await store.tryAdd('2026-08', 500, SMS_MONTHLY_CAP_PENCE);
    await expect(store.tryAdd('2026-09', 500, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);
  });

  it('is atomic under concurrent contention: 200 concurrent 5p adds against a 500p cap stop at exactly 100 commits with no overshoot', async () => {
    const store = new InMemorySpendCounterStore();
    const results = await Promise.all(
      Array.from({ length: 200 }, () => store.tryAdd('2026-08', 5, SMS_MONTHLY_CAP_PENCE)),
    );
    const committed = results.filter(Boolean).length;
    expect(committed).toBe(100);
    // The 101st commit must be rejected outright, proving the total never overshoots.
    await expect(store.tryAdd('2026-08', 5, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(false);
  });
});
