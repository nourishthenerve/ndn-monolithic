// 2026-09-01: the patient's own dashboard feed. Two routes, one column of
// the matrix — so most of this file is the *denials*, which are what make
// "a clinician cannot read a patient's dashboard" a fact rather than an
// intention.
import type { PatientNotification } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import type { PatientNotificationStore } from './patient-notification-repository.js';
import { PatientNotificationRepository } from './patient-notification-repository.js';
import { createPatientNotificationHandler } from './patient-notification.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const OWNING_PATIENT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};
const OTHER_PATIENT = {
  subjectId: 'pat-9',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-9',
};
const PRINCIPAL = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};
const SUB_CLINICIAN = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-1',
};
const HELPDESK = {
  subjectId: 'hd-1',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'hd-1',
};
const VISITOR = {
  subjectId: 'vis-1',
  role: 'visitor',
  accountStatus: 'active',
  clinicianId: 'vis-1',
};

const CLINICIAN_ACTOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'r', sourceIp: '198.51.100.2' },
);

class InMemoryPatientNotificationStore implements PatientNotificationStore {
  readonly items: PatientNotification[] = [];

  async create(notification: PatientNotification): Promise<void> {
    this.items.push(notification);
  }

  async listForPatient(patientId: string, limit: number): Promise<PatientNotification[]> {
    return this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => b.notificationId.localeCompare(a.notificationId))
      .slice(0, limit);
  }

  async markRead(
    patientId: string,
    notificationId: string,
  ): Promise<PatientNotification | undefined> {
    const item = this.items.find(
      (it) => it.patientId === patientId && it.notificationId === notificationId,
    );
    if (!item) {
      return undefined;
    }
    const updated = { ...item, read: true };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }
}

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : OWNING_PATIENT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function build(overrides: { flagEnabled?: boolean } = {}) {
  const store = new InMemoryPatientNotificationStore();
  let seq = 0;
  const notifications = new PatientNotificationRepository(store, clock, {
    newId: () => `n${(seq += 1)}`,
  });
  const flagSource = new InMemoryFlagSource();
  flagSource.set('appointments.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });
  return {
    handler: createPatientNotificationHandler({ notifications, flags, clock }),
    notifications,
    store,
  };
}

async function invoke(
  handler: ReturnType<typeof createPatientNotificationHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const LIST_ROUTE = 'GET /patients/me/notifications';
const READ_ROUTE = 'POST /patients/me/notifications/{notificationId}/read';

describe('GET /patients/me/notifications', () => {
  it('returns the calling patient\'s own feed, newest first', async () => {
    const { handler, notifications } = build();
    await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    await notifications.notify('pat-1', 'appointment-approved', CLINICIAN_ACTOR, {
      subjectAt: '2026-09-01T10:00:00.000Z',
    });

    const response = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: PatientNotification[] };
    expect(body.items.map((item) => item.kind)).toEqual([
      'appointment-approved',
      'calendar-updated',
    ]);
  });

  // 2026-09-02. `appointment-requested` stopped being written that day, but
  // the rows already in the owner's own feed would have stayed on screen
  // forever otherwise — the reported bug was a notification that already
  // existed, not one about to be created. Suppressing the kind on read is
  // what clears them without deleting stored rows.
  it('hides a retired appointment-requested row that predates the change', async () => {
    const { handler, notifications } = build();
    await notifications.notify('pat-1', 'appointment-requested', CLINICIAN_ACTOR, {
      subjectAt: '2026-09-18T13:33:00.000Z',
    });
    await notifications.notify('pat-1', 'appointment-approved', CLINICIAN_ACTOR, {
      subjectAt: '2026-09-18T13:33:00.000Z',
    });

    const response = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    const body = JSON.parse(response.body) as { items: PatientNotification[] };
    expect(body.items.map((item) => item.kind)).toEqual(['appointment-approved']);
  });

  it('hides it even when it is the only thing in the feed, leaving an empty one', async () => {
    const { handler, notifications } = build();
    await notifications.notify('pat-1', 'appointment-requested', CLINICIAN_ACTOR, {
      subjectAt: '2026-09-18T13:33:00.000Z',
    });

    const response = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });

  it('never returns another patient\'s feed — there is no parameter through which to name one', async () => {
    const { handler, notifications } = build();
    await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, principal: OTHER_PATIENT }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });

  it.each([
    ['the principal clinician', PRINCIPAL],
    ['a sub-clinician', SUB_CLINICIAN],
    ['a helpdesk account', HELPDESK],
    ['a visitor account', VISITOR],
  ])('is 403 for %s — a patient\'s dashboard is nobody else\'s to read', async (_l, principal) => {
    const { handler, notifications } = build();
    await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    const response = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE, principal }));
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    expect(response.statusCode).toBe(404);
  });

  it('is 403 for a suspended patient — status gates before the row does', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
        principal: { ...OWNING_PATIENT, accountStatus: 'suspended' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /patients/me/notifications/{notificationId}/read', () => {
  it('marks the caller\'s own notice read', async () => {
    const { handler, notifications } = build();
    const created = await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: READ_ROUTE, pathParameters: { notificationId: created.notificationId } }),
    );
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { item: PatientNotification }).item.read).toBe(true);
  });

  it('is 404 for another patient\'s notice — the id is not enough, the partition is the caller\'s own', async () => {
    const { handler, notifications } = build();
    const created = await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: READ_ROUTE,
        pathParameters: { notificationId: created.notificationId },
        principal: OTHER_PATIENT,
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 403 for a clinician', async () => {
    const { handler, notifications } = build();
    const created = await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: READ_ROUTE,
        pathParameters: { notificationId: created.notificationId },
        principal: PRINCIPAL,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 400 with no notification id', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }));
    expect(response.statusCode).toBe(400);
  });

  it('is 404 for an unknown route on this function', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ routeKey: 'GET /patients/{id}' }));
    expect(response.statusCode).toBe(404);
  });
});

describe('PatientNotificationRepository', () => {
  it('stores a kind, a time and an actor id — and no prose anyone authored', async () => {
    const { notifications, store } = build();
    await notifications.notify('pat-1', 'appointment-approved', CLINICIAN_ACTOR, {
      subjectAt: '2026-09-01T10:00:00.000Z',
    });
    // Asserted as an exact key set rather than a spot-check: the reason
    // this entity is safe to put on a dashboard without a matrix row of
    // its own is that there is nowhere in it for content to live, and a
    // field added later should have to argue for itself here first.
    expect(Object.keys(store.items[0] ?? {}).sort()).toEqual([
      'actorId',
      'created_at',
      'kind',
      'notificationId',
      'patientId',
      'read',
      'status',
      'subjectAt',
      'updated_at',
    ]);
  });

  it('orders two notices written in the same millisecond by their unique suffix', async () => {
    const { notifications, store } = build();
    await notifications.notify('pat-1', 'appointment-requested', CLINICIAN_ACTOR);
    await notifications.notify('pat-1', 'appointment-approved', CLINICIAN_ACTOR);
    expect(store.items.map((item) => item.notificationId)).toEqual([
      '2026-08-22T09:00:00.000Z#n1',
      '2026-08-22T09:00:00.000Z#n2',
    ]);
  });

  it('records the actor as an id, never a name', async () => {
    const { notifications, store } = build();
    await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    expect(store.items[0]?.actorId).toBe('principal-sub');
  });

  it('omits subjectAt entirely when the notice is not about a time', async () => {
    const { notifications, store } = build();
    await notifications.notify('pat-1', 'calendar-updated', CLINICIAN_ACTOR);
    expect(Object.hasOwn(store.items[0] ?? {}, 'subjectAt')).toBe(false);
  });
});
