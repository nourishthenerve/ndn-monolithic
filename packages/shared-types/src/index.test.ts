import { describe, expect, it } from 'vitest';

import type { Connection } from './connection.js';
import type { ContentItem } from './content.js';
import type { Testimonial } from './testimonial.js';
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

  it('Testimonial overrides BaseRecord.status with its own lifecycle, never "deleted"', () => {
    const testimonial: Testimonial = {
      id: 'testimonial-1',
      status: 'pending_review',
      quote: { en: 'This service changed my recovery.' },
      attribution: { display: 'firstNameOnly', name: 'Jordan' },
      consent: {
        textVersion: '2026-08-14',
        consentedAt: '2026-01-01T00:00:00.000Z',
        submitterContactHash: 'abc123',
      },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(testimonial.status).toBe('pending_review');
  });

  it('Connection overrides BaseRecord.status with connected|disconnected, never "deleted"', () => {
    const connection: Connection = {
      connectionId: 'abc123=',
      principalId: 'sub-1',
      role: 'patient',
      status: 'connected',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ttl: 1_767_225_600,
    };
    expect(connection.status).toBe('connected');
    expect(connection.disconnectedAt).toBeUndefined();
  });
});
