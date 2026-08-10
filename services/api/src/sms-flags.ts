// TASK 0.5.3's Flag: `sms.enabled` — default off, plus an independent kill
// switch for R-02 (SMS pumping fraud): an operator can stop all sending
// immediately without a deploy, even after sms.enabled has been turned on.
// Both will be read from SSM Parameter Store (D-14) once the generic,
// cached flag store lands (TASK 0.6.1) — SmsFlagReader is the seam that
// implementation will satisfy. InMemorySmsFlagReader is what today's tests
// use, and both it and its default state start with nothing able to send.
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
