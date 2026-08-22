import { describe, expect, it } from 'vitest';

import { t } from '../index.js';

import { NOTIFICATION_TEMPLATE_IDS, NOTIFICATION_TEMPLATES } from './index.js';

describe('NOTIFICATION_TEMPLATES', () => {
  it('has exactly one smsEligible template — the 1-hour appointment reminder (D-10, R-01)', () => {
    const smsEligible = NOTIFICATION_TEMPLATE_IDS.filter((id) => NOTIFICATION_TEMPLATES[id].smsEligible);
    expect(smsEligible).toEqual(['appointmentReminder1Hour']);
  });

  it('gives every smsEligible template an smsBodyKey, and every other template none', () => {
    for (const id of NOTIFICATION_TEMPLATE_IDS) {
      const def = NOTIFICATION_TEMPLATES[id];
      if (def.smsEligible) {
        expect(def.smsBodyKey).toBeDefined();
      } else {
        expect(def.smsBodyKey).toBeUndefined();
      }
    }
  });

  it('resolves every declared key to real content in the en catalogue — a missing key renders empty, not a placeholder', () => {
    // A superset of every var any template today references ({time},
    // {headline}) — ICU MessageFormat throws on a referenced var with no
    // value, so this proves each key exists and renders, not just that it
    // would if called correctly.
    const vars = { time: '14:00', headline: 'A headline' };
    for (const id of NOTIFICATION_TEMPLATE_IDS) {
      const def = NOTIFICATION_TEMPLATES[id];
      expect(t(def.subjectKey, vars)).not.toBe('');
      expect(t(def.emailBodyKey, vars)).not.toBe('');
      if (def.smsBodyKey) {
        expect(t(def.smsBodyKey, vars)).not.toBe('');
      }
    }
  });
});
