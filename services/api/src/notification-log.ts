// TASK 2.3.1: the notification delivery log. R-01's mitigation register
// ends on "never silently drop a reminder" — a property this log exists to
// make provable rather than assumed: `notifications.ts`'s `Notifier`
// appends exactly one record per `send()` call, on every branch, success
// or not.
//
// Same discipline as `audit.ts`'s writer (00-conventions.md: "never log
// PII or clinical content — log identifiers only"): a record carries a
// recipient id, a template id, a channel and an outcome, and never an
// email address, a phone number or a message body. Following `store.ts`'s
// precedent, `DeliveryLog` is the seam a durable, DynamoDB-backed
// implementation can satisfy later; `InMemoryDeliveryLog` is what today's
// tests and today's callers use — nothing sends a real notification yet.
export type Channel = 'email' | 'sms' | 'in-app';
export type DeliveryOutcome = 'sent' | 'degraded' | 'failed';

export interface DeliveryRecord {
  readonly at: string;
  /** The recipient's id (e.g. a patient's Cognito `sub`) — never an address. */
  readonly recipientId: string;
  readonly template: string;
  readonly channel: Channel;
  readonly outcome: DeliveryOutcome;
  /** 'Capped' | 'Blocked' | 'NotUk' | 'RateLimited' | 'MarketingOptOut' | 'EmailSendFailed' | … */
  readonly reason?: string;
}

export interface DeliveryLog {
  append(record: DeliveryRecord): Promise<void>;
}

export class InMemoryDeliveryLog implements DeliveryLog {
  private readonly records: DeliveryRecord[] = [];

  async append(record: DeliveryRecord): Promise<void> {
    this.records.push(record);
  }

  list(): readonly DeliveryRecord[] {
    return [...this.records];
  }
}
