// TASK 2.4.1's own Tests line: creating a second principal is rejected; a
// deactivated clinician's record is still readable by id.
import type { Clinician } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

// 00-conventions.md: "time is injectable — no test reads the wall clock."
const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const PRINCIPAL_ACTOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'req-1', sourceIp: '203.0.113.9' },
);

function build() {
  const store = new InMemoryClinicianStore();
  const audit = new InMemoryAuditLog();
  return { store, audit, clinicians: new ClinicianRepository(store, audit, clock) };
}

describe('create', () => {
  it('creates an active clinician, keyed by the Cognito sub', async () => {
    const { clinicians } = build();
    const clinician = await clinicians.create(
      'sub-1',
      { displayName: 'A Clinician', role: 'sub' },
      PRINCIPAL_ACTOR,
    );

    expect(clinician).toMatchObject({
      id: 'sub-1',
      displayName: 'A Clinician',
      role: 'sub',
      account_status: 'active',
      status: 'active',
    });
  });

  it('allows exactly one principal, and rejects a second', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-1', { displayName: 'First', role: 'principal' }, PRINCIPAL_ACTOR);

    await expect(
      clinicians.create('sub-2', { displayName: 'Second', role: 'principal' }, PRINCIPAL_ACTOR),
    ).rejects.toThrow(AppError);
    await expect(
      clinicians.create('sub-2', { displayName: 'Second', role: 'principal' }, PRINCIPAL_ACTOR),
    ).rejects.toMatchObject({ code: 'PRINCIPAL_ALREADY_EXISTS' });
  });

  it('allows any number of sub-clinicians alongside the one principal', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-0', { displayName: 'Principal', role: 'principal' }, PRINCIPAL_ACTOR);
    await clinicians.create('sub-1', { displayName: 'Sub A', role: 'sub' }, PRINCIPAL_ACTOR);
    await clinicians.create('sub-2', { displayName: 'Sub B', role: 'sub' }, PRINCIPAL_ACTOR);

    expect((await clinicians.findById('sub-1'))?.role).toBe('sub');
    expect((await clinicians.findById('sub-2'))?.role).toBe('sub');
  });

  it('rejects a second create for the same id', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-1', { displayName: 'A', role: 'sub' }, PRINCIPAL_ACTOR);

    await expect(
      clinicians.create('sub-1', { displayName: 'B', role: 'sub' }, PRINCIPAL_ACTOR),
    ).rejects.toMatchObject({ code: 'RECORD_ALREADY_EXISTS' });
  });

  it('writes one audit row per creation, with the acting principal', async () => {
    const { clinicians, audit } = build();
    await clinicians.create('sub-1', { displayName: 'A', role: 'sub' }, PRINCIPAL_ACTOR);

    const events = audit.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'create',
      entityType: 'clinician',
      entityId: 'sub-1',
      actor: 'principal-sub',
      actorRole: 'principal-clinician',
    });
  });
});

describe('deactivate / reactivate', () => {
  it('sets account_status to deactivated, and back to active on reactivation', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-1', { displayName: 'A', role: 'sub' }, PRINCIPAL_ACTOR);

    const deactivated = await clinicians.deactivate('sub-1', PRINCIPAL_ACTOR);
    expect(deactivated.account_status).toBe('deactivated');

    const reactivated = await clinicians.reactivate('sub-1', PRINCIPAL_ACTOR);
    expect(reactivated.account_status).toBe('active');
  });

  it('a deactivated clinician record is still readable by id, name and role intact', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-1', { displayName: 'A Clinician', role: 'sub' }, PRINCIPAL_ACTOR);
    await clinicians.deactivate('sub-1', PRINCIPAL_ACTOR);

    const found = await clinicians.findById('sub-1');
    expect(found).toMatchObject({
      id: 'sub-1',
      displayName: 'A Clinician',
      role: 'sub',
      account_status: 'deactivated',
      // The row itself is as live as ever — only the account's operative
      // status differs. Same distinction patient-repository.ts draws
      // between `status` and `account_status`.
      status: 'active',
    });
  });

  it('never changes role', async () => {
    const { clinicians } = build();
    await clinicians.create('sub-1', { displayName: 'A', role: 'principal' }, PRINCIPAL_ACTOR);
    const deactivated = await clinicians.deactivate('sub-1', PRINCIPAL_ACTOR);
    expect(deactivated.role).toBe('principal');
  });

  it('throws RECORD_NOT_FOUND for an id that was never created', async () => {
    const { clinicians } = build();
    await expect(clinicians.deactivate('nope', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    });
  });

  it('writes one audit row per transition', async () => {
    const { clinicians, audit } = build();
    await clinicians.create('sub-1', { displayName: 'A', role: 'sub' }, PRINCIPAL_ACTOR);
    await clinicians.deactivate('sub-1', PRINCIPAL_ACTOR);

    const events = audit.list();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ action: 'update', entityType: 'clinician', entityId: 'sub-1' });
  });
});

describe('no delete', () => {
  it('exposes no method that removes a record', () => {
    // `transition` is `private` in TypeScript only — the runtime prototype
    // still carries it, and both deactivate/reactivate route through it.
    const methods = Object.getOwnPropertyNames(ClinicianRepository.prototype);
    expect(methods.sort()).toEqual([
      'constructor',
      'create',
      'deactivate',
      'findById',
      'list',
      'reactivate',
      'transition',
      'updateDisplayName',
    ]);
  });
});

describe('InMemoryClinicianStore', () => {
  it('allows a principal to be created after an earlier one was rejected for a different id', async () => {
    // A rejected create must not have left partial state behind — this is
    // the in-memory store's own atomicity contract, exercised directly.
    const store = new InMemoryClinicianStore();
    const first: Clinician = {
      id: 'sub-1',
      displayName: 'A',
      role: 'principal',
      account_status: 'active',
      status: 'active',
      created_at: '2026-08-22T09:00:00.000Z',
      updated_at: '2026-08-22T09:00:00.000Z',
    };
    await store.create(first);

    const second: Clinician = { ...first, id: 'sub-2' };
    await expect(store.create(second)).rejects.toMatchObject({ code: 'PRINCIPAL_ALREADY_EXISTS' });

    // The first principal is still exactly as it was — no partial write.
    expect(await store.get('sub-1')).toEqual(first);
    expect(await store.get('sub-2')).toBeUndefined();
  });
});
