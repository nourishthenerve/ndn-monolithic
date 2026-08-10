// TASK 0.5.3 (C-02, R-01, R-02): steps 1-2 of the SMS hard-cap mechanism —
// an atomic monthly spend counter and the £5 cap it enforces, built before
// any SMS can be sent so the cap can never be breached even once. "Atomic"
// means a DynamoDB ConditionExpression-guarded UpdateItem once a table
// exists; no such table is deployed yet — following store.ts's precedent,
// SpendCounterStore is a seam InMemorySpendCounterStore satisfies today,
// and a DynamoDB-backed implementation can satisfy identically once the
// notification service (M2.2, ADR 0008) actually sends anything.
export const SMS_MONTHLY_CAP_PENCE = 500; // C-02: £5/month hard cap

export interface SpendCounterStore {
  /**
   * Atomically adds `amountPence` to the running total for `monthKey`, but
   * only if the resulting total would not exceed `capPence`. Returns
   * whether the add was committed; on a `false` return, no state changed —
   * this must never partially apply.
   */
  tryAdd(monthKey: string, amountPence: number, capPence: number): Promise<boolean>;
}

export function currentMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class InMemorySpendCounterStore implements SpendCounterStore {
  private readonly totals = new Map<string, number>();

  // No `await` between the read and the write below: every call to this
  // method runs its check-then-commit to completion before the next queued
  // call starts, which is exactly the guarantee a DynamoDB conditional
  // update would give under real concurrency — so a `Promise.all` of many
  // concurrent callers is a faithful test of atomicity, not a cheat.
  async tryAdd(monthKey: string, amountPence: number, capPence: number): Promise<boolean> {
    const current = this.totals.get(monthKey) ?? 0;
    const next = current + amountPence;
    if (next > capPence) return false;
    this.totals.set(monthKey, next);
    return true;
  }
}
