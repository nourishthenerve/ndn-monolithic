import { describe, expect, it } from 'vitest';

import type { PersonRecord } from './person-record.js';
import { projectClinical, projectPersonal, withClinical, withPersonal } from './person-record.js';

interface Clinical {
  diagnosisCode: string;
}

interface Personal {
  name: string;
  email: string;
  marketingOptIn: boolean;
}

function buildRecord(): PersonRecord<Clinical, Personal> {
  return {
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    status: 'active',
    clinical: { diagnosisCode: 'G35' },
    personal: { name: 'Ada', email: 'ada@example.com', marketingOptIn: true },
  };
}

describe('projectClinical / projectPersonal', () => {
  it('project the clinical and personal attribute sets independently', () => {
    const record = buildRecord();
    expect(projectClinical(record)).toEqual({ diagnosisCode: 'G35' });
    expect(projectPersonal(record)).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      marketingOptIn: true,
    });
  });

  it('return the exact attribute set stored on the record, not a copy', () => {
    const record = buildRecord();
    expect(projectClinical(record)).toBe(record.clinical);
    expect(projectPersonal(record)).toBe(record.personal);
  });
});

describe('withClinical', () => {
  it('replaces only the clinical set — personal is untouched, by reference', () => {
    const record = buildRecord();
    const updated = withClinical(record, { diagnosisCode: 'G36' });
    expect(updated.clinical).toEqual({ diagnosisCode: 'G36' });
    expect(updated.personal).toBe(record.personal);
  });
});

describe('withPersonal', () => {
  it('replaces only the personal set — clinical is untouched, by reference', () => {
    const record = buildRecord();
    const updated = withPersonal(record, {
      name: 'Ada',
      email: 'ada@example.com',
      marketingOptIn: false,
    });
    expect(updated.personal).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      marketingOptIn: false,
    });
    expect(updated.clinical).toBe(record.clinical);
  });

  it('a field-level change to personal needs no rewrite of clinical — the TASK 0.3.4 DoD', () => {
    const record = buildRecord();
    const withoutMarketing = withPersonal(record, { ...record.personal, marketingOptIn: false });
    expect(withoutMarketing.clinical).toBe(record.clinical);
    expect(withoutMarketing.created_at).toBe(record.created_at);
    expect(withoutMarketing.status).toBe(record.status);
  });
});

describe('withClinical and withPersonal composed', () => {
  it('each helper only ever touches its own half, in either order', () => {
    const record = buildRecord();
    const clinicalThenPersonal = withPersonal(withClinical(record, { diagnosisCode: 'G36' }), {
      ...record.personal,
      marketingOptIn: false,
    });
    expect(clinicalThenPersonal.clinical).toEqual({ diagnosisCode: 'G36' });
    expect(clinicalThenPersonal.personal).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      marketingOptIn: false,
    });
    expect(record.clinical).toEqual({ diagnosisCode: 'G35' });
    expect(record.personal).toEqual({
      name: 'Ada',
      email: 'ada@example.com',
      marketingOptIn: true,
    });
  });
});
