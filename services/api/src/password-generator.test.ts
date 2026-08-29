import { describe, expect, it } from 'vitest';

import { GENERATED_PASSWORD_LENGTH, generatePassword } from './password-generator.js';

describe('generatePassword', () => {
  it('is exactly the declared length, every time', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
    }
  });

  it('always satisfies the patient pool\'s password policy (auth-stack.ts)', () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%&*+=?]/);
    }
  });

  it('never contains a visually ambiguous character', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it('does not repeat — two calls draw from a real random source', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(passwords.size).toBe(50);
  });
});
