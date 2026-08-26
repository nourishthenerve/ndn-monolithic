import { describe, expect, it } from 'vitest';

import { classifyMediaError } from './DeviceCheck.js';

function domException(name: string): Error {
  const error = new Error(`synthetic ${name}`);
  error.name = name;
  return error;
}

describe('classifyMediaError', () => {
  it('classifies a denied-permission error', () => {
    expect(classifyMediaError(domException('NotAllowedError'))).toBe('denied');
    expect(classifyMediaError(domException('PermissionDeniedError'))).toBe('denied');
    expect(classifyMediaError(domException('SecurityError'))).toBe('denied');
  });

  it('classifies a no-device error', () => {
    expect(classifyMediaError(domException('NotFoundError'))).toBe('unavailable');
    expect(classifyMediaError(domException('DevicesNotFoundError'))).toBe('unavailable');
    expect(classifyMediaError(domException('OverconstrainedError'))).toBe('unavailable');
  });

  it('falls back to the generic error state for anything else, never throwing', () => {
    expect(classifyMediaError(domException('AbortError'))).toBe('error');
    expect(classifyMediaError(new Error('a plain, unnamed error'))).toBe('error');
    expect(classifyMediaError('not even an Error instance')).toBe('error');
    expect(classifyMediaError(undefined)).toBe('error');
  });
});
