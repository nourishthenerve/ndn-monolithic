// TASK 2.5.3's own Tests line, the parts a repository-level test can
// prove directly: pagination round-trips a cursor and never drops or
// repeats an item across pages; a patient that fell out of the caseload
// between the index read and the follow-up GetItem is skipped, not
// surfaced stale.
//
// "Every documented access pattern resolves to a Query, never a Scan" is
// proven at the `DynamoCaseloadStore` level (dynamo-store.test.ts),
// against a mocked AWS SDK client that can assert which command was
// actually sent — this file's own `FakeCaseloadStore` has no notion of
// `Query`/`Scan` to assert against.
import type { Patient, Principal } from '@ndn/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import { CaseloadRepository, type CaseloadStore } from './caseload-repository.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const PRINCIPAL: Principal = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

function buildPatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'pat-1',
    personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    clinical: {},
    account_status: 'approved',
    assigned_clinician_id: 'cli-1',
    keywords: [],
    status: 'active',
    created_at: '2026-08-22T08:00:00.000Z',
    updated_at: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

/** A GSI3 stand-in: pages through a fixed, ordered list of patient ids, `limit` at a time. */
class FakeCaseloadStore implements CaseloadStore {
  constructor(
    private readonly orderedIds: readonly string[],
    private readonly patients: Map<string, Patient>,
  ) {}

  async queryPage(cursor: string | undefined, limit: number) {
    const start = cursor ? Number(cursor) : 0;
    const page = this.orderedIds.slice(start, start + limit);
    const nextIndex = start + page.length;
    return {
      patientIds: page,
      nextCursor: nextIndex < this.orderedIds.length ? String(nextIndex) : undefined,
    };
  }

  async getPatient(patientId: string): Promise<Patient | undefined> {
    return this.patients.get(patientId);
  }

  /** Keyed by patient id — the fixture's stand-in for an `APPT#` partition. */
  totalAppointments = new Map<string, number>();

  async countAppointments(patientId: string) {
    return this.totalAppointments.get(patientId) ?? 0;
  }

  /** The real store counts two GSI3 partitions; here it is the same arithmetic over the fixture. */
  async count() {
    const present = this.orderedIds
      .map((id) => this.patients.get(id))
      .filter((patient): patient is Patient => Boolean(patient));
    return {
      total: present.length,
      active: present.filter((patient) => patient.account_status === 'approved').length,
    };
  }
}

async function build(patients: Patient[]) {
  const clinicianStore = new InMemoryClinicianStore();
  const clinicians = new ClinicianRepository(clinicianStore, new InMemoryAuditLog(), clock);
  await clinicians.create(
    'cli-1',
    { displayName: 'A Clinician', role: 'sub' },
    { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
  );

  const byId = new Map(patients.map((p) => [p.id, p]));
  const store = new FakeCaseloadStore(
    patients.map((p) => p.id),
    byId,
  );
  return { repository: new CaseloadRepository(store, clinicians), store };
}

describe('listPage', () => {
  it('returns entries with the patient name and the assigned clinician name', async () => {
    const { repository } = await build([buildPatient()]);

    const page = await repository.listPage(PRINCIPAL, undefined, 10);

    expect(page.items).toEqual([
      {
        patientId: 'pat-1',
        fullName: 'A Patient',
        accountStatus: 'approved',
        assignedClinicianId: 'cli-1',
        assignedClinicianName: 'A Clinician',
      },
    ]);
    expect(page.nextCursor).toBeUndefined();
  });

  // 2026-08-31: the change that made this a dashboard rather than a
  // caseload. A `pending` patient nobody is responsible for yet used to be
  // dropped here (and, before that, was never in GSI3 at all) — they are
  // precisely the row the principal opens this page to act on.
  it('includes an unassigned patient, with no clinician fields rather than no row', async () => {
    const { repository } = await build([
      buildPatient({ id: 'pat-new', account_status: 'pending', assigned_clinician_id: undefined }),
    ]);

    const page = await repository.listPage(PRINCIPAL, undefined, 10);

    expect(page.items).toEqual([
      { patientId: 'pat-new', fullName: 'A Patient', accountStatus: 'pending' },
    ]);
  });

  it('counts every patient and the active subset, on the first page only', async () => {
    const { repository } = await build([
      buildPatient({ id: 'pat-1' }),
      buildPatient({ id: 'pat-2' }),
      buildPatient({ id: 'pat-3', account_status: 'pending', assigned_clinician_id: undefined }),
    ]);

    const first = await repository.listPage(PRINCIPAL, undefined, 2);
    expect(first.counts).toEqual({ total: 3, active: 2 });

    const second = await repository.listPage(PRINCIPAL, first.nextCursor, 2);
    expect(second.counts).toBeUndefined();
  });

  it('does not count on a later page — a count is a fact about the directory, not the page', async () => {
    const { repository, store } = await build([buildPatient({ id: 'pat-1' }), buildPatient({ id: 'pat-2' })]);
    const countSpy = vi.spyOn(store, 'count');

    await repository.listPage(PRINCIPAL, '1', 1);

    expect(countSpy).not.toHaveBeenCalled();
  });

  it('paginates: a cursor round-trips, and every item across all pages appears exactly once', async () => {
    const patients = Array.from({ length: 5 }, (_, i) =>
      buildPatient({ id: `pat-${i}`, personal: { fullName: `Patient ${i}`, email: `p${i}@example.com`, marketingOptIn: false } }),
    );
    const { repository } = await build(patients);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.listPage(PRINCIPAL, cursor, 2);
      seen.push(...page.items.map((item) => item.patientId));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['pat-0', 'pat-1', 'pat-2', 'pat-3', 'pat-4']);
    expect(new Set(seen).size).toBe(5); // no repeats
  });

  it('caches a clinician name within one page rather than re-fetching it per patient', async () => {
    const patients = [
      buildPatient({ id: 'pat-1' }),
      buildPatient({ id: 'pat-2' }),
    ];
    const { repository, store } = await build(patients);
    const getPatientSpy = vi.spyOn(store, 'getPatient');

    await repository.listPage(PRINCIPAL, undefined, 10);

    // Both patients read (no shortcut there) — only the clinician lookup is cached.
    expect(getPatientSpy).toHaveBeenCalledTimes(2);
  });

  // 2026-08-31: the visitor's whole view, and the one authorisation rule
  // this repository holds that the matrix does not.
  describe('a visitor', () => {
    const VISITOR: Principal = {
      subjectId: 'visitor-sub',
      role: 'visitor',
      accountStatus: 'active',
      clinicianId: 'visitor-sub',
    };

    async function buildTagged() {
      const built = await build([
        buildPatient({
          id: 'pat-iic',
          tag: 'IIC',
          personal: {
            fullName: 'IIC Patient',
            email: 'iic@example.com',
            address: '1 Example Street',
            marketingOptIn: false,
          },
        }),
        buildPatient({ id: 'pat-ndn', tag: 'NDN' }),
        // No tag at all — a record written before tagging existed. Absence
        // must never be read as membership.
        buildPatient({ id: 'pat-untagged', tag: undefined }),
      ]);
      built.store.totalAppointments.set('pat-iic', 3);
      return built;
    }

    it('sees IIC-tagged patients only — an untagged record is not IIC', async () => {
      const { repository } = await buildTagged();

      const page = await repository.listPage(VISITOR, undefined, 10);

      expect(page.items.map((item) => item.patientId)).toEqual(['pat-iic']);
    });

    it('sees name, address and a completed-appointment count, and nothing else', async () => {
      const { repository } = await buildTagged();

      const [entry] = (await repository.listPage(VISITOR, undefined, 10)).items;

      expect(entry).toEqual({
        patientId: 'pat-iic',
        fullName: 'IIC Patient',
        accountStatus: 'approved',
        tag: 'IIC',
        address: '1 Example Street',
        totalAppointments: 3,
      });
      // The fields a visitor must never receive are absent from the
      // payload, not merely unrendered by a caller.
      expect(entry).not.toHaveProperty('assignedClinicianId');
      expect(entry).not.toHaveProperty('assignedClinicianName');
      expect(JSON.stringify(entry)).not.toContain('iic@example.com');
    });

    it('skips a non-IIC patient entirely rather than returning a blanked row', async () => {
      // A redacted row would still disclose that the patient exists,
      // which is the fact the tag is there to keep.
      const { repository } = await buildTagged();
      const page = await repository.listPage(VISITOR, undefined, 10);
      expect(page.items).toHaveLength(1);
    });

    it('still gives every other role the full entry, count included where it belongs', async () => {
      const { repository, store } = await buildTagged();
      const countSpy = vi.spyOn(store, 'countAppointments');

      const page = await repository.listPage(PRINCIPAL, undefined, 10);

      expect(page.items).toHaveLength(3);
      expect(page.items[0]).toMatchObject({ assignedClinicianName: 'A Clinician' });
      // Not computed for anyone but a visitor — a query per patient per
      // page to render a number no other view shows.
      expect(countSpy).not.toHaveBeenCalled();
    });
  });

  it('skips a patient that fell out of the caseload between the index read and the GetItem', async () => {
    class StaleIndexStore implements CaseloadStore {
      async queryPage() {
        return { patientIds: ['ghost'], nextCursor: undefined };
      }
      async getPatient() {
        return undefined; // the record is gone since the index write
      }
      async count() {
        return { total: 0, active: 0 };
      }
      async countAppointments() {
        return 0;
      }
    }
    const clinicianStore = new InMemoryClinicianStore();
    const clinicians = new ClinicianRepository(clinicianStore, new InMemoryAuditLog(), clock);
    const staleRepository = new CaseloadRepository(new StaleIndexStore(), clinicians);

    const page = await staleRepository.listPage(PRINCIPAL, undefined, 10);
    expect(page.items).toEqual([]);
  });
});
