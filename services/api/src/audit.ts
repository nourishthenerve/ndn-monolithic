// docs/plan/04-data-model-rbac.md: "Audit event | AUDIT#<date> / <ts>#<id> |
// Append-only, who/what/when/where." AuditWriter is the interface
// Repository/VersionedRepository write through; InMemoryAuditLog is today's
// implementation (no DynamoDB table exists yet — see store.ts). It exposes
// no method that removes an entry, by construction.
// TASK 1.3.2: 'publish'/'unpublish' are their own actions, not folded into
// 'update' — content.status is domain-specific (draft|published|unpublished,
// packages/shared-types/src/content.ts) and doesn't go through
// Repository<T>'s active|deleted lifecycle, so the audit trail names the
// transition precisely rather than collapsing it into a generic 'update'.
// TASK 1.4.2: 'reject' is testimonial's own equivalent of 'unpublish' — a
// status transition, same discipline, named precisely for the same reason.
export type AuditAction = 'create' | 'update' | 'soft-delete' | 'publish' | 'unpublish' | 'reject';

export interface AuditEvent {
  readonly at: string;
  readonly actor: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}

export class InMemoryAuditLog implements AuditWriter {
  private readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }
}
