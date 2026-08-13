import { describe, expect, it } from 'vitest';

import type { ContentItem } from './content.js';
import type { BaseRecord, RecordStatus } from './types.js';

describe('shared-types', () => {
  it('BaseRecord defaults its Status parameter to RecordStatus', () => {
    const record: BaseRecord = {
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active' satisfies RecordStatus,
    };
    expect(record.status).toBe('active');
  });

  it('ContentItem overrides BaseRecord.status with its own lifecycle, never "deleted"', () => {
    const item: ContentItem = {
      id: 'content-1',
      contentType: 'blog',
      status: 'draft',
      keywords: ['nutrition'],
      translations: { en: { title: 'T', body: 'B', excerpt: 'E' } },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(item.status).toBe('draft');
  });
});
