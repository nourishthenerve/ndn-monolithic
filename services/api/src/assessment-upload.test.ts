// 2026-09-01: "Based on who has access to which section that person will
// be able to upload these docs/media files." The check under test is that
// the *section* decides, and that no part of the minted key can be steered
// by the request.
import type { Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { isAttachmentKeyInSection } from './assessment-attachments.js';
import { createAssessmentUploadHandler } from './assessment-upload.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const SEED_ACTOR = actorContext(
  { subjectId: 'seed', role: 'principal-clinician' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const OWNING_PATIENT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};
const ASSIGNED_SUB = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-1',
};
const UNASSIGNED_SUB = {
  subjectId: 'sub-2',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-2',
};
const PRINCIPAL = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
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

// 2026-09-02: `/attachments/…`. These live on WebStack's own API and reach
// the browser same-origin through CloudFront — the old `/patients/…` paths
// were registered on a different API from the one the client called, so
// every request 404'd. See assessment-upload.ts's own note.
const ROUTE = 'POST /attachments/{id}/{assessmentId}/upload-url';
const PATH = { id: 'pat-1', assessmentId: 'intake-v1' };

function fakeEvent(overrides: {
  routeKey?: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey ?? ROUTE,
    pathParameters: overrides.pathParameters ?? PATH,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : ASSIGNED_SUB },
    },
  } as unknown as LambdaAuthorizerEvent;
}

async function build(overrides: { flagEnabled?: boolean } = {}) {
  const patientStore = new InMemoryStore<Patient>();
  const patients = new PatientRepository(patientStore, new InMemoryAuditLog(), clock);
  await patients.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
      tag: 'NDN',
    },
    SEED_ACTOR,
  );
  const existing = await patientStore.get('pat-1');
  if (existing) {
    await patientStore.put('pat-1', { ...existing, assigned_clinician_id: 'cli-1' });
  }

  const flagSource = new InMemoryFlagSource();
  flagSource.set('assessments.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const signed: { key: string; contentType: string }[] = [];
  const signedReads: string[] = [];
  const handler = createAssessmentUploadHandler({
    patients,
    flags,
    clock,
    generateId: () => 'fixed-uuid',
    createPresignedPutUrl: (key, contentType) => {
      signed.push({ key, contentType });
      return Promise.resolve(`https://media.example/${key}?sig=x`);
    },
    createPresignedGetUrl: (key) => {
      signedReads.push(key);
      return Promise.resolve(`https://media.example/${key}?sig=read`);
    },
  });
  return { handler, signed, signedReads };
}

async function invoke(
  handler: ReturnType<typeof createAssessmentUploadHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('who may upload into which section', () => {
  it('mints a URL for a clinician uploading into the clinician section', async () => {
    const { handler, signed } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        body: { section: 'private', fileName: 'note.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toEqual({
      uploadUrl: 'https://media.example/assessments/pat-1/intake-v1/private/fixed-uuid-note.pdf?sig=x',
      key: 'assessments/pat-1/intake-v1/private/fixed-uuid-note.pdf',
    });
    expect(signed).toHaveLength(1);
  });

  it('mints one for the patient uploading into general info — the one section they may write', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        principal: OWNING_PATIENT,
        body: { section: 'general', fileName: 'photo.jpg', contentType: 'image/jpeg' },
      }),
    );
    expect(response.statusCode).toBe(201);
  });

  it.each([
    ['the patient section', 'patient'],
    ['the clinician section', 'private'],
    ['the calendar section', 'calendar'],
  ])('is 403, and signs nothing, for the patient uploading into %s', async (_l, section) => {
    const { handler, signed } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        principal: OWNING_PATIENT,
        body: { section, fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(403);
    // The refusal must produce no presigned URL at all — not even for a
    // key nobody will ever write to.
    expect(signed).toHaveLength(0);
  });

  it('lets helpdesk upload into the general and patient sections, and refuses the other two', async () => {
    const { handler } = await build();
    for (const section of ['general', 'patient']) {
      const allowed = await invoke(
        handler,
        fakeEvent({
          principal: HELPDESK,
          body: { section, fileName: 'x.pdf', contentType: 'application/pdf' },
        }),
      );
      expect(allowed.statusCode).toBe(201);
    }
    for (const section of ['private', 'calendar']) {
      const denied = await invoke(
        handler,
        fakeEvent({
          principal: HELPDESK,
          body: { section, fileName: 'x.pdf', contentType: 'application/pdf' },
        }),
      );
      expect(denied.statusCode).toBe(403);
    }
  });

  it('lets the principal upload into every section', async () => {
    const { handler } = await build();
    for (const section of ['general', 'patient', 'private', 'calendar']) {
      const response = await invoke(
        handler,
        fakeEvent({
          principal: PRINCIPAL,
          body: { section, fileName: 'x.pdf', contentType: 'application/pdf' },
        }),
      );
      expect(response.statusCode).toBe(201);
    }
  });

  it.each([
    ['an unassigned sub-clinician', UNASSIGNED_SUB],
    ['a visitor', VISITOR],
  ])('is 403 for %s, in every section', async (_l, principal) => {
    const { handler } = await build();
    for (const section of ['general', 'patient', 'private', 'calendar']) {
      const response = await invoke(
        handler,
        fakeEvent({
          principal,
          body: { section, fileName: 'x.pdf', contentType: 'application/pdf' },
        }),
      );
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('the key is built from server-held values only', () => {
  it('sanitises the caller\'s file name rather than using it as-is', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        body: {
          section: 'general',
          fileName: '../../etc/pass wd;rm -rf.pdf',
          contentType: 'application/pdf',
        },
      }),
    );
    expect(response.statusCode).toBe(201);
    const { key } = JSON.parse(response.body) as { key: string };
    expect(key).toBe('assessments/pat-1/intake-v1/general/fixed-uuid-.-.-etc-pass-wd-rm--rf.pdf');
    expect(key.startsWith('assessments/pat-1/intake-v1/general/')).toBe(true);
  });

  // The bug this catches, found while writing these tests: the character
  // filter keeps `.`, so `../notes.pdf` sanitised to `..-notes.pdf` — a key
  // the *recording* step refuses for containing `..`. The upload would have
  // been authorised and the attachment could never have appeared on the
  // record. Both halves now agree by construction.
  it('mints no key containing "..", so every key it issues is one the record will accept', async () => {
    const { handler } = await build();
    for (const fileName of ['../notes.pdf', '....pdf', 'a..b..c.pdf']) {
      const response = await invoke(
        handler,
        fakeEvent({ body: { section: 'general', fileName, contentType: 'application/pdf' } }),
      );
      const { key } = JSON.parse(response.body) as { key: string };
      expect(key).not.toContain('..');
      expect(isAttachmentKeyInSection(key, 'pat-1', 'intake-v1', 'general')).toBe(true);
    }
  });

  it('resolves /patients/me to the caller — never to an id the body could name', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        pathParameters: { id: 'me', assessmentId: 'intake-v1' },
        principal: OWNING_PATIENT,
        body: { section: 'general', fileName: 'photo.jpg', contentType: 'image/jpeg' },
      }),
    );
    const { key } = JSON.parse(response.body) as { key: string };
    expect(key.startsWith('assessments/pat-1/')).toBe(true);
  });
});

describe('what may be uploaded', () => {
  it.each([
    ['a picture', 'image/png'],
    ['audio', 'audio/mpeg'],
    ['video', 'video/mp4'],
    ['a pdf', 'application/pdf'],
    ['a word document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ])('accepts %s — the owner\'s own list', async (_l, contentType) => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ body: { section: 'general', fileName: 'file', contentType } }),
    );
    expect(response.statusCode).toBe(201);
  });

  it('is 400 for a content type outside the allow-list — "etc" is not "anything"', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        body: { section: 'general', fileName: 'x.html', contentType: 'text/html' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 400 for a section that is not one of the four', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        body: { section: 'billing', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('route plumbing', () => {
  it('is 401 with no verified principal, and signs nothing', async () => {
    const { handler, signed } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        principal: undefined,
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(401);
    expect(signed).toHaveLength(0);
  });

  it('is 404 when the flag is off, and signs nothing', async () => {
    const { handler, signed } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(404);
    expect(signed).toHaveLength(0);
  });

  it('is 403, not 404, for a caller the matrix denies against a patient that does not exist', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        pathParameters: { id: 'pat-nobody', assessmentId: 'intake-v1' },
        principal: UNASSIGNED_SUB,
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 404 for a patient that does not exist, once the caller is authorised', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        pathParameters: { id: 'pat-nobody', assessmentId: 'intake-v1' },
        principal: PRINCIPAL,
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 404 for an unknown route on this function', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /workshops/media-upload-url',
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

// 2026-09-01: the read half. `/media/*` serves the bucket to anyone with
// the path — right for a workshop poster, catastrophic for a clinical
// recording — so an assessment attachment is reachable *only* here, behind
// the same section-level check that governs the record it belongs to.
describe('downloading an attachment', () => {
  const DOWNLOAD_ROUTE = 'POST /attachments/{id}/{assessmentId}/download-url';
  const GENERAL_KEY = 'assessments/pat-1/intake-v1/general/fixed-uuid-photo.jpg';
  const PRIVATE_KEY = 'assessments/pat-1/intake-v1/private/fixed-uuid-note.pdf';

  it('signs a GET for a caller who may read the section', async () => {
    const { handler, signedReads } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        body: { section: 'general', key: GENERAL_KEY },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      downloadUrl: `https://media.example/${GENERAL_KEY}?sig=read`,
    });
    expect(signedReads).toEqual([GENERAL_KEY]);
  });

  it('needs only read, not write — a patient downloads from a section they cannot add to', async () => {
    const { handler } = await build();
    const download = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        body: { section: 'patient', key: 'assessments/pat-1/intake-v1/patient/fixed-uuid-x.pdf' },
      }),
    );
    expect(download.statusCode).toBe(200);
    const upload = await invoke(
      handler,
      fakeEvent({
        principal: OWNING_PATIENT,
        body: { section: 'patient', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(upload.statusCode).toBe(403);
  });

  it('is 403, and signs nothing, for a section the caller may not read', async () => {
    const { handler, signedReads } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        body: { section: 'private', key: PRIVATE_KEY },
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(signedReads).toEqual([]);
  });

  it('is 403 for a key outside the named section — the presigner has no opinion about what it signs, so this check must', async () => {
    const { handler, signedReads } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        // A section the patient *can* read, naming a key from one they cannot.
        body: { section: 'general', key: PRIVATE_KEY },
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(signedReads).toEqual([]);
  });

  it('is 403 for a key belonging to another patient', async () => {
    const { handler, signedReads } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        body: { section: 'general', key: 'assessments/pat-2/intake-v1/general/fixed-uuid-x.jpg' },
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(signedReads).toEqual([]);
  });

  it('is 403 for a key that climbs out of its section with ..', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: OWNING_PATIENT,
        body: {
          section: 'general',
          key: 'assessments/pat-1/intake-v1/general/../private/note.pdf',
        },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 404 for a visitor outside their programme, before any URL is signed', async () => {
    const { handler, signedReads } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: VISITOR,
        body: { section: 'general', key: GENERAL_KEY },
      }),
    );
    // The seeded patient is tagged NDN.
    expect(response.statusCode).toBe(404);
    expect(signedReads).toEqual([]);
  });

  it('is 400 when the body names a file to upload rather than a key to read', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: DOWNLOAD_ROUTE,
        principal: PRINCIPAL,
        body: { section: 'general', fileName: 'x.pdf', contentType: 'application/pdf' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });
});
