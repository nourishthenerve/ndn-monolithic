// TASK 0.5.3's Flag: `sms.enabled` — default off, plus an independent kill
// switch for R-02 (SMS pumping fraud): an operator can stop all sending
// immediately without a deploy, even after sms.enabled has been turned on.
// Both will be read from SSM Parameter Store (D-14) through the generic,
// cached flag store (TASK 0.6.1) — GenericSmsFlagReader is the
// implementation that satisfies the SmsFlagReader seam, backed by whatever
// FlagReader it's given (an SSM-backed one once a Lambda actually sends SMS,
// in M2.2). InMemorySmsFlagReader is what today's tests use directly, and
// both it and its default state start with nothing able to send.
import type { FlagReader } from './flags.js';

export interface SmsFlags {
  readonly enabled: boolean;
  readonly killSwitchEngaged: boolean;
}

export interface SmsFlagReader {
  read(): Promise<SmsFlags>;
}

const SAFE_DEFAULT: SmsFlags = { enabled: false, killSwitchEngaged: false };

export class InMemorySmsFlagReader implements SmsFlagReader {
  private flags: SmsFlags;

  constructor(initial: SmsFlags = SAFE_DEFAULT) {
    this.flags = initial;
  }

  async read(): Promise<SmsFlags> {
    return this.flags;
  }

  set(patch: Partial<SmsFlags>): void {
    this.flags = { ...this.flags, ...patch };
  }
}

export class GenericSmsFlagReader implements SmsFlagReader {
  constructor(private readonly flags: FlagReader) {}

  async read(): Promise<SmsFlags> {
    const [enabled, killSwitchEngaged] = await Promise.all([
      this.flags.isEnabled('sms.enabled'),
      this.flags.isEnabled('sms.killSwitchEngaged'),
    ]);
    return { enabled, killSwitchEngaged };
  }
}
