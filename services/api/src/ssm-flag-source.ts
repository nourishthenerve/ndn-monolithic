// TASK 1.6.2: the SSM-backed FlagSource that flags.ts's own header has
// pointed at since TASK 0.6.1 ("FlagSource is the interface an SSM
// GetParameter-backed implementation can satisfy later without FlagReader
// changing") and that sms-flags.ts named as a dependency of M2.2. Until it
// existed, every production handler wired an InMemoryFlagSource that
// nothing ever wrote to, so every flag read `false` forever and no
// operator action could change that — D-23 chose homegrown config-driven
// flags precisely so a flag could be flipped *without* a deploy, and the
// dark-launch half was working while the enable half did not exist. Found
// and quantified in docs/plan/gate-g1-report.md §3a.
//
// Deliberately a separate module from flags.ts: flags.ts is pure logic
// imported by every request path, and it should not drag @aws-sdk/client-ssm
// into bundles that never read a parameter. Same split sms-flags.ts uses.
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';

import { systemClock, type Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, type FlagName, type FlagSource } from './flags.js';

// Mirrors infra/src/config.ts's FLAG_PARAMETER_NAME_PREFIX — that constant
// is what web-stack.ts/data-stack.ts actually set this env var to at deploy
// time; the literal here is only a local-dev/test fallback, the same
// convention contact-form-handler.ts documents for
// TURNSTILE_SECRET_PARAMETER_NAME.
export const FLAG_PARAMETER_NAME_PREFIX = process.env.FLAG_PARAMETER_NAME_PREFIX ?? '/ndn/flags/';

export interface SsmFlagSourceOptions {
  /** Parameter-name prefix; the flag's own name is appended verbatim. */
  readonly prefix?: string;
  /** Defaults to a real client — tests inject a mocked one (aws-sdk-client-mock) instead. */
  readonly client?: SSMClient;
}

/**
 * Reads one flag per `GetParameter` from `${prefix}${name}`.
 *
 * **Fail-closed on every path.** A flag is only ever `true` if a parameter
 * exists and holds exactly `'true'`. Anything else — parameter absent, an
 * unrecognised value, an SSM error — resolves `undefined`, which
 * `CachedFlagReader` turns into `false`. That ordering is deliberate: an
 * SSM outage or a fat-fingered value darkens a feature for at most one
 * cache TTL, where throwing would instead 500 the request and take a
 * working page down over a config read.
 *
 * These are plain `String` parameters, not `SecureString` — a flag's state
 * is not a secret, and `WithDecryption` would need a KMS grant for nothing.
 */
export class SsmFlagSource implements FlagSource {
  private readonly client: SSMClient;
  private readonly prefix: string;

  constructor(options: SsmFlagSourceOptions = {}) {
    this.client = options.client ?? new SSMClient({});
    this.prefix = options.prefix ?? FLAG_PARAMETER_NAME_PREFIX;
  }

  async read(name: FlagName): Promise<boolean | undefined> {
    const parameterName = `${this.prefix}${name}`;
    let value: string | undefined;
    try {
      const result = await this.client.send(new GetParameterCommand({ Name: parameterName }));
      value = result.Parameter?.Value;
    } catch (error: unknown) {
      // A flag with no parameter is the documented steady state — every
      // flag ships off and stays off until an operator creates one — so
      // this is not a warning, it is the normal answer.
      if (error instanceof ParameterNotFound) {
        return undefined;
      }
      warn('flags.ssm_read_failed', {
        parameterName,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return undefined;
    }

    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    // A value that is neither is a misconfiguration, not a `false` an
    // operator meant. Reported, then treated as unset — same fail-closed
    // outcome, but loudly, so `True`/`1`/`yes` never reads as "off" in
    // silence when someone believed they had turned a feature on.
    warn('flags.ssm_unrecognised_value', { parameterName });
    return undefined;
  }
}

// Structured and non-PII — a parameter name and a reason code, never a
// value. `console.warn`, not `console.log` (00-conventions.md bans
// debug-level logging, not warnings), matching packages/i18n's
// defaultMissingTranslationHandler.
function warn(msg: string, fields: Record<string, string>): void {
  console.warn(JSON.stringify({ msg, ...fields }));
}

export interface SsmFlagReaderOptions {
  readonly clock?: Clock;
  readonly ttlMs?: number;
  readonly source?: FlagSource;
}

/**
 * The one-liner every `*-handler.ts` uses in place of the five-line
 * `CachedFlagReader`/`InMemoryFlagSource` block each of them used to
 * repeat. Nine copies of that block is nine places for the TTL, the clock
 * or the source to drift; this is one.
 */
export function createSsmFlagReader(options: SsmFlagReaderOptions = {}): CachedFlagReader {
  return new CachedFlagReader({
    source: options.source ?? new SsmFlagSource(),
    clock: options.clock ?? systemClock,
    ttlMs: options.ttlMs ?? FLAG_CACHE_TTL_MS,
  });
}
