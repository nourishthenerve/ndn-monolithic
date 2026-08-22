// TASK 0.6.1 (§10, D-23): the generic, cached flag store that sms-flags.ts's
// SmsFlagReader was written against in advance — "SmsFlagReader is the seam
// that implementation will satisfy" (TASK 0.5.3). No SSM parameter exists
// for any flag yet (0.4.1 is the first task that deploys application infra,
// and nothing deployed today reads a flag at runtime) — following store.ts's
// precedent, FlagSource is the interface an SSM GetParameter-backed
// implementation can satisfy later without FlagReader changing.
// InMemoryFlagSource is what today's tests and today's callers use.
import type { Clock } from './clock.js';

// Every flag any part of the system reads goes through this union so a
// typo in a flag name is a compile error, not a silently-false runtime read.
export type FlagName =
  | 'sms.enabled'
  | 'sms.killSwitchEngaged'
  | 'content.readApi.enabled'
  | 'content.authoring.enabled'
  | 'contact.form.enabled'
  | 'testimonials.submission.enabled'
  | 'testimonials.moderationQueue.enabled'
  | 'workshops.enabled'
  | 'payments.stripeCheckout.enabled'
  // TASK 2.1.3: gates the principal clinician's `GET /audit?date=` only.
  // There is deliberately no flag for the audit *writer*: a log that can
  // be switched off is not an audit log.
  | 'audit.readApi.enabled'
  // TASK 2.2.3: default off until TASK 2.5.1 exists to approve anyone.
  // Registering into a system with no route out of `pending` is not a
  // smaller feature, it is a worse one.
  | 'auth.patientRegistration.enabled'
  // TASK 2.2.4: the whole `/auth/*` surface and the account pages. Off
  // means the site is exactly the brochure it is today.
  | 'auth.webSignIn.enabled'
  // TASK 2.4.1: create/deactivate/reactivate clinician accounts. Default
  // off until a principal clinician exists to operate it — the same
  // "flag is not a convenience" reasoning auth.patientRegistration.enabled
  // documents.
  | 'clinicians.administration.enabled'
  // TASK 2.5.1: turned on together with auth.patientRegistration.enabled
  // — registering into a system with no route out of `pending` strands
  // people there, which is this flag's own DoD line.
  | 'assignment.enabled';

export interface FlagSource {
  /** Raw read of one flag. Undefined means the flag has never been set. */
  read(name: FlagName): Promise<boolean | undefined>;
}

export class InMemoryFlagSource implements FlagSource {
  private readonly values = new Map<FlagName, boolean>();

  async read(name: FlagName): Promise<boolean | undefined> {
    return this.values.get(name);
  }

  set(name: FlagName, value: boolean): void {
    this.values.set(name, value);
  }
}

export interface FlagReader {
  /** A flag that was never set, or isn't recognised by the source, is off — this is how incomplete work merges dark. */
  isEnabled(name: FlagName): Promise<boolean>;
}

// D-23: homegrown, config-driven flags — a short in-process TTL avoids a
// network round trip on every request while still letting an operator flip
// a flag without a deploy. 30s bounds how stale a cached read can be against
// that goal.
export const FLAG_CACHE_TTL_MS = 30_000;

export interface CachedFlagReaderOptions {
  readonly source: FlagSource;
  readonly clock: Clock;
  readonly ttlMs: number;
}

interface CacheEntry {
  readonly value: boolean;
  readonly readAtMs: number;
}

export class CachedFlagReader implements FlagReader {
  private readonly cache = new Map<FlagName, CacheEntry>();

  constructor(private readonly options: CachedFlagReaderOptions) {}

  async isEnabled(name: FlagName): Promise<boolean> {
    const nowMs = this.options.clock.now().getTime();
    const cached = this.cache.get(name);
    if (cached && nowMs - cached.readAtMs < this.options.ttlMs) {
      return cached.value;
    }
    const value = (await this.options.source.read(name)) ?? false;
    this.cache.set(name, { value, readAtMs: nowMs });
    return value;
  }
}
