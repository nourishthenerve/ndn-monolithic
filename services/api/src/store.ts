// Storage seam for the repository layer. No DynamoDB table is deployed yet
// (docs/runbooks/iam-deny-guardrails.md — TASK 0.4.1 is the first task that
// deploys real application infrastructure), so Repository/VersionedRepository
// are written against this interface rather than an AWS SDK client. A
// DynamoDB-backed implementation can satisfy it later without either
// repository class changing. InMemoryStore is what today's tests use.
export interface KeyValueStore<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, item: T): Promise<void>;
}

export class InMemoryStore<T> implements KeyValueStore<T> {
  private readonly items = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.items.get(key);
  }

  async put(key: string, item: T): Promise<void> {
    this.items.set(key, item);
  }
}
