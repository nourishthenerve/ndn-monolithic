// docs/plan/04-data-model-rbac.md: "Audit event | AUDIT#<date> / <ts>#<id> |
// Append-only, who/what/when/where." AuditWriter is the interface
// Repository/VersionedRepository write through; InMemoryAuditLog is today's
// implementation (no DynamoDB table exists yet — see store.ts). It exposes
// no method that removes an entry, by construction.
export type AuditAction = 'create' | 'update' | 'soft-delete';

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
