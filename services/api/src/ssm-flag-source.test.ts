import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { createSsmFlagReader, SsmFlagSource } from './ssm-flag-source.js';

const ssmMock = mockClient(SSMClient);

function source(): SsmFlagSource {
  return new SsmFlagSource({
    prefix: '/ndn/flags/',
    client: ssmMock as unknown as SSMClient,
  });
}

function notFound(): ParameterNotFound {
  return new ParameterNotFound({ message: 'not found', $metadata: {} });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ssmMock.reset();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe('SsmFlagSource', () => {
  it('reads the flag name appended to the prefix, as a plain (undecrypted) parameter', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'true' } });

    await source().read('content.authoring.enabled');

    const calls = ssmMock.commandCalls(GetParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toEqual({ Name: '/ndn/flags/content.authoring.enabled' });
    // A flag's state is not a secret — asking for decryption would need a
    // KMS grant these roles deliberately do not have.
    expect(calls[0]?.args[0].input).not.toHaveProperty('WithDecryption');
  });

  it("resolves true for exactly 'true' and false for exactly 'false'", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'true' } });
    expect(await source().read('workshops.enabled')).toBe(true);

    ssmMock.reset();
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'false' } });
    expect(await source().read('workshops.enabled')).toBe(false);
  });

  it('treats a missing parameter as unset, quietly — that is the documented steady state', async () => {
    ssmMock.on(GetParameterCommand).rejects(notFound());

    expect(await source().read('workshops.enabled')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(['True', 'TRUE', '1', 'yes', 'enabled', ''])(
    'refuses to read %o as a flag value, warns, and falls back to unset',
    async (value) => {
      ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: value } });

      expect(await source().read('payments.stripeCheckout.enabled')).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
        msg: 'flags.ssm_unrecognised_value',
        parameterName: '/ndn/flags/payments.stripeCheckout.enabled',
      });
    },
  );

  it('never throws on an SSM failure — it warns and falls back to unset, so a config read cannot 500 a request', async () => {
    const error = new Error('throttled');
    error.name = 'ThrottlingException';
    ssmMock.on(GetParameterCommand).rejects(error);

    expect(await source().read('content.authoring.enabled')).toBeUndefined();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
      msg: 'flags.ssm_read_failed',
      parameterName: '/ndn/flags/content.authoring.enabled',
      reason: 'ThrottlingException',
    });
  });

  it('never logs a parameter value, only its name — values are operator input', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'definitely-not-a-boolean' } });

    await source().read('testimonials.enabled');

    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain('definitely-not-a-boolean');
  });
});

describe('createSsmFlagReader', () => {
  class FixedClock implements Clock {
    constructor(private readonly at: Date) {}
    now(): Date {
      return this.at;
    }
  }

  it('caches, so a warm container does not call SSM once per request', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'true' } });
    const reader = createSsmFlagReader({
      source: source(),
      clock: new FixedClock(new Date('2026-08-21T09:00:00.000Z')),
    });

    expect(await reader.isEnabled('workshops.enabled')).toBe(true);
    expect(await reader.isEnabled('workshops.enabled')).toBe(true);

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it('fails closed end-to-end: an unreachable SSM leaves every flag off, not thrown', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('network is unreachable'));
    const reader = createSsmFlagReader({
      source: source(),
      clock: new FixedClock(new Date('2026-08-21T09:00:00.000Z')),
    });

    await expect(reader.isEnabled('payments.stripeCheckout.enabled')).resolves.toBe(false);
  });
});
