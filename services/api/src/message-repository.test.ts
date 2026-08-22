import type { Message } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import type { MessagePage, MessageStore } from './message-repository.js';
import { MessageRepository } from './message-repository.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const PATIENT_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

const SUB_ACTOR = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-2', sourceIp: '198.51.100.7' },
);

/** A minimal in-memory `MessageStore` — this file tests `MessageRepository`'s own logic, not a real Dynamo Query/cursor shape (that's `dynamo-store.test.ts`'s job). */
class InMemoryMessageStore implements MessageStore {
  private readonly items: Message[] = [];

  async create(message: Message): Promise<void> {
    this.items.push(message);
  }

  async listForThread(patientId: string, cursor: string | undefined, limit: number): Promise<MessagePage> {
    const all = this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? String(start + limit) : undefined;
    return { items: page, nextCursor };
  }
}

function build() {
  const store = new InMemoryMessageStore();
  const audit = new InMemoryAuditLog();
  const repository = new MessageRepository(store, audit, clock);
  return { repository, store, audit };
}

describe('MessageRepository.send', () => {
  it("sets senderId to the actor's own subjectId, never a body-supplied value", async () => {
    const { repository } = build();
    const sent = await repository.send(
      { patientId: 'pat-1', senderRole: 'patient', body: 'Hello' },
      PATIENT_ACTOR,
    );
    expect(sent.senderId).toBe('pat-1');
    expect(sent.senderRole).toBe('patient');
    expect(sent.body).toBe('Hello');
    expect(sent.created_at).toBe('2026-08-22T09:00:00.000Z');
    expect(sent.status).toBe('active');
  });

  it('writes an audit entry keyed by patient and timestamp', async () => {
    const { repository, audit } = build();
    await repository.send({ patientId: 'pat-1', senderRole: 'patient', body: 'Hello' }, PATIENT_ACTOR);
    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'create',
        entityType: 'message',
        entityId: 'pat-1#2026-08-22T09:00:00.000Z',
      }),
    ]);
  });

  it('records a sub-clinician-sent message with the correct senderRole', async () => {
    const { repository } = build();
    const sent = await repository.send(
      { patientId: 'pat-1', senderRole: 'sub-clinician', body: 'Hi there' },
      SUB_ACTOR,
    );
    expect(sent.senderId).toBe('sub-1');
    expect(sent.senderRole).toBe('sub-clinician');
  });
});

describe('MessageRepository.listForThread', () => {
  it("returns a patient's own thread, chronologically (oldest-first)", async () => {
    const { repository, store } = build();
    await store.create({
      patientId: 'pat-1',
      senderId: 'pat-1',
      senderRole: 'patient',
      body: 'second',
      created_at: '2026-08-22T09:05:00.000Z',
      updated_at: '2026-08-22T09:05:00.000Z',
      status: 'active',
    });
    await store.create({
      patientId: 'pat-1',
      senderId: 'sub-1',
      senderRole: 'sub-clinician',
      body: 'first',
      created_at: '2026-08-22T09:00:00.000Z',
      updated_at: '2026-08-22T09:00:00.000Z',
      status: 'active',
    });
    const page = await repository.listForThread('pat-1');
    expect(page.items.map((item) => item.body)).toEqual(['first', 'second']);
  });

  it("never returns another patient's thread", async () => {
    const { repository } = build();
    await repository.send({ patientId: 'pat-1', senderRole: 'patient', body: 'mine' }, PATIENT_ACTOR);
    const page = await repository.listForThread('pat-2');
    expect(page.items).toEqual([]);
  });

  it('returns an empty page for a patient with no messages', async () => {
    const { repository } = build();
    const page = await repository.listForThread('pat-1');
    expect(page).toEqual({ items: [], nextCursor: undefined });
  });
});
