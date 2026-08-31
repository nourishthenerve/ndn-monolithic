import type { ContentAssignment, ContentItem, Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import type { ContentAssignmentStore } from './content-assignment-repository.js';
import { ContentAssignmentRepository } from './content-assignment-repository.js';
import { createContentAssignmentHandler } from './content-assignment.js';
import { ContentRepository, InMemoryContentStore } from './content-repository.js';
import { AppError } from './errors.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const OWNER_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const OWNING_PATIENT_CONTEXT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

const ASSIGNED_SUB_CONTEXT = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-1',
};

const UNASSIGNED_SUB_CONTEXT = {
  subjectId: 'sub-2',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-2',
};

const PRINCIPAL_CONTEXT = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

/** In-memory `ContentAssignmentStore` — this file exercises `content-assignment.ts`'s own routing/authz logic; the real Query/`begins_with` shape is `dynamo-store.test.ts`'s job. */
class InMemoryContentAssignmentStore implements ContentAssignmentStore {
  private readonly items: ContentAssignment[] = [];

  async create(assignment: ContentAssignment): Promise<void> {
    const collides = this.items.some(
      (item) => item.patientId === assignment.patientId && item.contentId === assignment.contentId,
    );
    if (collides) {
      throw new AppError(
        'RECORD_ALREADY_EXISTS',
        `patient ${assignment.patientId} already has content ${assignment.contentId} assigned`,
      );
    }
    this.items.push(assignment);
  }

  async listForPatient(patientId: string): Promise<ContentAssignment[]> {
    return this.items.filter((item) => item.patientId === patientId);
  }
}

const PUBLISHED: Omit<ContentItem, 'created_at' | 'updated_at'> = {
  id: 'content-1',
  contentType: 'blog',
  status: 'published',
  keywords: ['nerve-pain'],
  translations: { en: { title: 'Managing nerve pain', body: 'Full text.', excerpt: 'A short excerpt.' } },
};

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : ASSIGNED_SUB_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

async function build(overrides: { flagEnabled?: boolean; seedContent?: boolean } = {}) {
  const patientStore = new InMemoryStore<Patient>();
  const patientAudit = new InMemoryAuditLog();
  const patients = new PatientRepository(patientStore, patientAudit, clock);
  await patients.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    },
    OWNER_ACTOR,
  );
  const existing = await patientStore.get('pat-1');
  if (existing) {
    await patientStore.put('pat-1', { ...existing, assigned_clinician_id: 'cli-1' });
  }

  const content = new ContentRepository(new InMemoryContentStore(), new InMemoryAuditLog(), clock);
  if (overrides.seedContent ?? true) {
    await content.create(OWNER_ACTOR, PUBLISHED);
  }

  const assignments = new ContentAssignmentRepository(
    new InMemoryContentAssignmentStore(),
    content,
    new InMemoryAuditLog(),
    clock,
  );

  const flagSource = new InMemoryFlagSource();
  flagSource.set('contentAssignment.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const handler = createContentAssignmentHandler({ patients, assignments, flags, clock });
  return { handler, patients, assignments };
}

async function invoke(
  handler: ReturnType<typeof createContentAssignmentHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const ASSIGN_ROUTE = 'POST /patients/{id}/content';
const LIST_ROUTE = 'GET /patients/{id}/content';

describe('POST /patients/{id}/content', () => {
  it('assigns published content for an assigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { patientId: string; contentId: string } };
    expect(body.item.patientId).toBe('pat-1');
    expect(body.item.contentId).toBe('content-1');
  });

  it('is 409, not a silent duplicate, when the content is already assigned to that patient', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('is 400 for content that does not exist or is not published', async () => {
    const { handler } = await build({ seedContent: false });
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("lets the principal assign content — the same cell the treating sub-clinician holds", async () => {
    const { handler, assignments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    // Flipped 2026-08-31 with the doc's `Principal` column: the
    // read-only cell this test guarded rested on the principal being an
    // overseer who never treats anyone, which is not who the principal
    // is in this practice. See 04-data-model-rbac.md's second
    // amendment of that date.
    expect(response.statusCode).toBe(201);
    await expect(assignments.listForPatient('pat-1')).resolves.toHaveLength(1);
  });

  it('is 403 for an unassigned sub-clinician, before any write', async () => {
    const { handler, assignments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(assignments.listForPatient('pat-1')).resolves.toEqual([]);
  });

  it('is 403 for the owning patient — the row grants bare R to the patient column', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
        principal: undefined,
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 for a missing contentId or an unrecognised body field', async () => {
    const { handler } = await build();
    const missing = await invoke(
      handler,
      fakeEvent({ routeKey: ASSIGN_ROUTE, pathParameters: { id: 'pat-1' }, body: {} }),
    );
    expect(missing.statusCode).toBe(400);

    const smuggled = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1', assignedBy: 'someone-else' },
      }),
    );
    expect(smuggled.statusCode).toBe(400);
  });

  it('is 403, not 404, for a caller the matrix denies — the refusal must not leak whether the patient exists', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'nobody' },
        body: { contentId: 'content-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    // Flipped 2026-08-31 with the doc's `Principal` column (see
    // 04-data-model-rbac.md's second amendment of that date). The
    // ordering property this test guards is unchanged and still worth
    // asserting — it has simply moved to the role the matrix still
    // denies here. A caller the matrix refuses must not learn from the
    // status code whether the patient exists.
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /patients/{id}/content', () => {
  async function seedAssignment(handler: ReturnType<typeof createContentAssignmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: ASSIGN_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { contentId: 'content-1' },
      }),
    );
  }

  it("returns the owning patient's own hydrated list", async () => {
    const { handler } = await build();
    await seedAssignment(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { contentId: string; title: string }[] };
    expect(body.items).toEqual([
      expect.objectContaining({ contentId: 'content-1', title: 'Managing nerve pain' }),
    ]);
  });

  it('resolves /patients/me/content to the owning patient', async () => {
    const { handler } = await build();
    await seedAssignment(handler);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'me' }, principal: OWNING_PATIENT_CONTEXT }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('is 200 for an assigned sub-clinician and for the principal', async () => {
    const { handler } = await build();
    await seedAssignment(handler);

    const subResponse = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' } }),
    );
    expect(subResponse.statusCode).toBe(200);

    const principalResponse = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: PRINCIPAL_CONTEXT }),
    );
    expect(principalResponse.statusCode).toBe(200);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: UNASSIGNED_SUB_CONTEXT }),
    );
    expect(response.statusCode).toBe(403);
  });

  it("is 403, never a 200 with a partial body, for a patient reading another patient's list by a guessed id", async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: { ...OWNING_PATIENT_CONTEXT, subjectId: 'pat-2', patientId: 'pat-2' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(404);
  });
});
