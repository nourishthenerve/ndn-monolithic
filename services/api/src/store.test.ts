import { describe, expect, it } from 'vitest';

import { InMemoryStore } from './store.js';

describe('InMemoryStore', () => {
  it('returns undefined for a key that was never put', async () => {
    const store = new InMemoryStore<{ name: string }>();
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('put then get round-trips the exact value', async () => {
    const store = new InMemoryStore<{ name: string }>();
    await store.put('a', { name: 'Ada' });
    await expect(store.get('a')).resolves.toEqual({ name: 'Ada' });
  });

  it('a later put replaces the value for that key without affecting others', async () => {
    const store = new InMemoryStore<{ name: string }>();
    await store.put('a', { name: 'Ada' });
    await store.put('b', { name: 'Grace' });
    await store.put('a', { name: 'Ada Lovelace' });
    await expect(store.get('a')).resolves.toEqual({ name: 'Ada Lovelace' });
    await expect(store.get('b')).resolves.toEqual({ name: 'Grace' });
  });
});
