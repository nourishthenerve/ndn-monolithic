import type { ContentAssignment, ContentItem } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import type { ContentAssignmentStore } from './content-assignment-repository.js';
import { ContentAssignmentRepository } from './content-assignment-repository.js';
import { ContentRepository, InMemoryContentStore } from './content-repository.js';
import { AppError } from './errors.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const ACTOR = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

/** A minimal in-memory `ContentAssignmentStore` — this file tests `ContentAssignmentRepository`'s own logic, not a real Dynamo `Query`/`begins_with` shape (that's `dynamo-store.test.ts`'s job). */
class InMemoryContentAssignmentStore implements ContentAssignmentStore {
  private readonly items: ContentAssignment[] = [];

  async create(assignment: ContentAssignment): Promise<void> {
    this.items.push(assignment);
  }

  async listForPatient(patientId: string): Promise<ContentAssignment[]> {
    return this.items.filter((item) => item.patientId === patientId);
  }
}

function build() {
  const store = new InMemoryContentAssignmentStore();
  const contentStore = new InMemoryContentStore();
  const contentAudit = new InMemoryAuditLog();
  const content = new ContentRepository(contentStore, contentAudit, clock);
  const audit = new InMemoryAuditLog();
  const repository = new ContentAssignmentRepository(store, content, audit, clock);
  return { repository, store, content, audit };
}

const PUBLISHED: Omit<ContentItem, 'created_at' | 'updated_at'> = {
  id: 'content-1',
  contentType: 'blog',
  status: 'published',
  keywords: ['nerve-pain'],
  translations: { en: { title: 'Managing nerve pain', body: 'Full text.', excerpt: 'A short excerpt.' } },
};

describe('ContentAssignmentRepository.assign', () => {
  it('assigns published content, stamping assignedAt to created_at', async () => {
    const { repository, content } = build();
    await content.create(ACTOR, PUBLISHED);
    const assignment = await repository.assign('pat-1', 'content-1', ACTOR);
    expect(assignment.patientId).toBe('pat-1');
    expect(assignment.contentId).toBe('content-1');
    expect(assignment.assignedAt).toBe('2026-08-22T09:00:00.000Z');
    expect(assignment.created_at).toBe('2026-08-22T09:00:00.000Z');
    expect(assignment.status).toBe('active');
  });

  it('writes an audit entry keyed by patient and content id', async () => {
    const { repository, content, audit } = build();
    await content.create(ACTOR, PUBLISHED);
    await repository.assign('pat-1', 'content-1', ACTOR);
    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'create',
        entityType: 'content-assignment',
        entityId: 'pat-1#content-1',
      }),
    ]);
  });

  it('throws AppError(CONTENT_NOT_PUBLISHED) for a draft item — never assignable', async () => {
    const { repository, content } = build();
    await content.create(ACTOR, { ...PUBLISHED, status: 'draft' });
    await expect(repository.assign('pat-1', 'content-1', ACTOR)).rejects.toThrow(AppError);
  });

  it('throws AppError(CONTENT_NOT_PUBLISHED) for content that does not exist', async () => {
    const { repository } = build();
    await expect(repository.assign('pat-1', 'no-such-content', ACTOR)).rejects.toThrow(AppError);
  });
});

describe('ContentAssignmentRepository.listForPatient', () => {
  it('hydrates each assignment with the content item\'s own title/excerpt', async () => {
    const { repository, content } = build();
    await content.create(ACTOR, PUBLISHED);
    await repository.assign('pat-1', 'content-1', ACTOR);
    const items = await repository.listForPatient('pat-1');
    expect(items).toEqual([
      {
        contentId: 'content-1',
        assignedAt: '2026-08-22T09:00:00.000Z',
        title: 'Managing nerve pain',
        excerpt: 'A short excerpt.',
      },
    ]);
  });

  it('never returns another patient\'s assignments', async () => {
    const { repository, content } = build();
    await content.create(ACTOR, PUBLISHED);
    await repository.assign('pat-1', 'content-1', ACTOR);
    const items = await repository.listForPatient('pat-2');
    expect(items).toHaveLength(0);
  });

  it('returns an empty list for a patient with no assignments', async () => {
    const { repository } = build();
    const items = await repository.listForPatient('pat-1');
    expect(items).toEqual([]);
  });
});
