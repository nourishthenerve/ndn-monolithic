// TASK 3.6.1: bespoke, not `Repository<T>`-based, for the same reason
// `content-assignment-repository.ts`'s own header names for the identical
// mistake in the task's own prose: the task's Step 1 cites `Repository<
// Message>` to justify the append-only discipline (no update, no
// soft-delete), but that class is single-key CRUD over `KeyValueStore<T>`
// — `get(id)`/`put(id, record)` — with no query capability at all, and
// this entity's own required read (`GET /patients/{id}/messages?cursor=`,
// "the thread") is inherently one-to-many. A `MessageStore` gives the
// identical append-only guarantee (its own interface has no update/delete
// method to begin with) while actually supporting the paginated list read.
import type { Message, MessageSenderRole } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { unprojected, type Unprojected } from './projection.js';

export const MESSAGE_ENTITY_TYPE = 'message';

/** One page of a thread — chronological (oldest-first), matching TASK 3.6.2's own "the thread as a list, oldest-first." */
export interface MessagePage {
  readonly items: readonly Message[];
  readonly nextCursor?: string;
}

export interface MessageStore {
  /** Conditioned on not already existing (`attribute_not_exists(pk)` on the real implementation) — the sort key's own uniqueness is the store's job, not the caller's. */
  create(message: Message): Promise<void>;
  /** Main-table `Query` on `PAT#<id>`, `begins_with(sk, 'MSG#')`, ascending — never a `Scan`. */
  listForThread(patientId: string, cursor: string | undefined, limit: number): Promise<MessagePage>;
}

export interface SendMessageInput {
  readonly patientId: string;
  readonly senderRole: MessageSenderRole;
  readonly body: string;
}

// One page of a thread. Not a query parameter (the task's own Interfaces
// line names only `?cursor=`) — a fixed size, the same "inherently
// bounded" reasoning this phase's other single-thread/single-patient lists
// already carry, sized generously enough that a real conversation rarely
// needs a second page.
export const MESSAGE_PAGE_SIZE = 50;

export class MessageRepository {
  constructor(
    private readonly store: MessageStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Only ever reaches this far when `can()` has already granted `create`
   * (`authz-matrix.ts`'s `Messages` row) — this method trusts the caller
   * to have checked, the same contract every other repository in this
   * codebase keeps. `senderId` is always `actor.subjectId`: the caller's
   * own identity, never a value a request body could name.
   */
  async send(input: SendMessageInput, actor: ActorContext): Promise<Unprojected<Message>> {
    const now = this.clock.now().toISOString();
    const message: Message = {
      patientId: input.patientId,
      senderId: actor.subjectId,
      senderRole: input.senderRole,
      body: input.body,
      created_at: now,
      updated_at: now,
      status: 'active',
    };
    await this.store.create(message);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: MESSAGE_ENTITY_TYPE,
        entityId: `${input.patientId}#${now}`,
      }),
    );
    return unprojected(message);
  }

  async listForThread(patientId: string, cursor?: string): Promise<MessagePage> {
    const page = await this.store.listForThread(patientId, cursor, MESSAGE_PAGE_SIZE);
    return { items: page.items.map(unprojected), nextCursor: page.nextCursor };
  }
}
