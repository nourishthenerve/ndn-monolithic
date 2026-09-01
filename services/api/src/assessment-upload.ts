// 2026-09-01: `POST /patients/{id}/assessments/{assessmentId}/attachment-upload-url`
// — "Inside those 3 sections there will be option to upload audio file,
// video file, pictures, word files, pdfs etc. Based on who has access to
// which section that person will be able to upload these docs/media files."
//
// Kept SDK-free (no `@aws-sdk/client-s3` import here) so it is unit-testable
// without AWS — `createPresignedPutUrl` is injected, and
// assessment-upload-handler.ts is the only place that calls the real S3
// presigner. The same split media-upload.ts (TASK 1.5.1) already uses.
//
// ## "Based on who has access to which section"
//
// That sentence is the whole authorisation rule, and it is implemented
// literally: the request names a section, and the check is the *same*
// `can(principal, 'update', {entityType: 'assessment', fieldSet})` that
// `assessment.ts` runs before recording anything in it. There is no
// separate "may upload" permission, because an upload that the record
// cannot then reference is not an upload anyone wanted — a helpdesk
// account that cannot write the clinician section gets no URL for it, and
// would not be able to record the result if it somehow had one.
//
// **The presigned URL is not the boundary; the key is.** A URL, once
// issued, is a bearer capability for as long as it lives, so this endpoint
// is careful about what it will mint one *for*: the key is built entirely
// from server-held values (the authorised patient id, the form id, the
// authorised section) plus a fresh uuid, and the caller's file name is
// sanitised before it is appended. Nothing a request body carries can
// steer the prefix. `assessment.ts` then refuses to record any attachment
// key outside that prefix, so even a leaked URL cannot land an object
// somewhere the record will acknowledge.
import { randomUUID } from 'node:crypto';

import type { FieldSet, Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import {
  ASSESSMENT_ATTACHMENT_CONTENT_TYPES,
  assessmentAttachmentPrefix,
  isAttachmentKeyInSection,
  sanitizeAttachmentFileName,
} from './assessment-attachments.js';
import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientRepository } from './patient-repository.js';
import { requirePrincipal } from './request-principal.js';

const ASSESSMENTS_FLAG = 'assessments.enabled';
const UPLOAD_ROUTE = 'POST /patients/{id}/assessments/{assessmentId}/attachment-upload-url';
const DOWNLOAD_ROUTE = 'POST /patients/{id}/assessments/{assessmentId}/attachment-download-url';
const UPLOAD_LOG_SAMPLE_RATE = 1;

const SECTION_ENUM = ['general', 'patient', 'private', 'calendar'] as const;

const uploadBodySchema = z
  .object({
    section: z.enum(SECTION_ENUM),
    fileName: z.string().min(1).max(200),
    contentType: z.enum(ASSESSMENT_ATTACHMENT_CONTENT_TYPES),
  })
  .strict();

const downloadBodySchema = z
  .object({
    section: z.enum(SECTION_ENUM),
    key: z.string().min(1).max(1024),
  })
  .strict();

/** The two request shapes this function serves, discriminated so the download branch reaches `key` and the upload branch cannot. */
type ParsedBody =
  | { readonly kind: 'upload'; readonly section: FieldSet; readonly fileName: string; readonly contentType: string }
  | { readonly kind: 'download'; readonly section: FieldSet; readonly key: string };

export interface AssessmentUploadDeps {
  /** For the assignment-relationship lookup `can()` needs — the sub-clinician column depends on `assigned_clinician_id`, which only the patient record can answer. */
  readonly patients: PatientRepository;
  readonly flags: FlagReader;
  /** Presigned `PutObject` URL for `key`/`contentType`, scoped to the media bucket's `assessments/` prefix — injected so no test calls real S3. */
  readonly createPresignedPutUrl: (key: string, contentType: string) => Promise<string>;
  /** Presigned `GetObject` URL for `key`. Same injection, same reason. */
  readonly createPresignedGetUrl: (key: string) => Promise<string>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Defaults to node:crypto's randomUUID — injectable so tests can assert on a known key. */
  readonly generateId?: () => string;
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createAssessmentUploadHandler(
  deps: AssessmentUploadDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createSampledLogger({ clock, sampleRate: UPLOAD_LOG_SAMPLE_RATE });
  const generateId = deps.generateId ?? randomUUID;

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    if (!(await deps.flags.isEnabled(ASSESSMENTS_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const isUpload = routeKey === UPLOAD_ROUTE;
    const isDownload = routeKey === DOWNLOAD_ROUTE;
    if (!isUpload && !isDownload) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const rawId = event.pathParameters?.id;
    const assessmentId = event.pathParameters?.assessmentId;
    if (!rawId || !assessmentId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    const patientId =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Parsed before the record is fetched: the section is what the
    // authorisation check needs, and a malformed body should not cost a
    // read. Nothing is authorised on the strength of it — `can()` still
    // runs below with the section it named.
    //
    // Parsed into a discriminated value rather than left as a union of two
    // zod results, so the download branch below reaches `key` without a
    // cast and the upload branch cannot reach it at all.
    const raw = parseJsonBody(event);
    let parsed: ParsedBody;
    if (isUpload) {
      const result = uploadBodySchema.safeParse(raw);
      if (!result.success) {
        return respond(400, { error: 'INVALID_BODY', issues: result.error.issues });
      }
      parsed = { kind: 'upload', ...result.data };
    } else {
      const result = downloadBodySchema.safeParse(raw);
      if (!result.success) {
        return respond(400, { error: 'INVALID_BODY', issues: result.error.issues });
      }
      parsed = { kind: 'download', ...result.data };
    }
    const section: FieldSet = parsed.section;

    const patient = await deps.patients.findById(patientId);
    // **Uploading needs `update`; downloading needs `read`.** The section
    // is the same, the verb is not — which is what lets a patient see the
    // scan a clinician attached to their general info without being able
    // to add one to the clinician's section.
    if (
      !can(principal, isUpload ? 'update' : 'read', {
        entityType: ASSESSMENT_ENTITY_TYPE,
        ownerPatientId: patientId,
        assignedClinicianId: patient?.assigned_clinician_id,
        fieldSet: section,
      }).allowed
    ) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    // After authorisation, never before: a caller with no reach into this
    // patient's section learns nothing about whether they exist.
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }
    // The same tag gate `assessment.ts` applies, with the same `404` and
    // for the same reason: a visitor must not be able to infer that a
    // patient outside their programme exists. Reachable on the download
    // route, where a visitor does hold `read` on two sections.
    if (principal.role === 'visitor' && patient.tag !== 'IIC') {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    if (parsed.kind === 'download') {
      // **The key is checked against the prefix, not merely trusted.**
      // Without this, a caller with read on their own general section
      // could name any key in the bucket and be handed a signed URL for
      // it — the presigner has no opinion about what it signs. Together
      // with the uuid in every minted key, this is what makes a signed
      // GET reach exactly the objects the caller's own section holds.
      if (!isAttachmentKeyInSection(parsed.key, patientId, assessmentId, section)) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const downloadUrl = await deps.createPresignedGetUrl(parsed.key);
      return respond(200, { downloadUrl });
    }

    const key = `${assessmentAttachmentPrefix(patientId, assessmentId, section)}${generateId()}-${sanitizeAttachmentFileName(parsed.fileName)}`;
    const uploadUrl = await deps.createPresignedPutUrl(key, parsed.contentType);
    // `key` is returned so the caller can name it in the section patch
    // that records the attachment. That second call is authorised
    // independently — the URL is permission to put an object, never
    // permission to have it appear on the record.
    return respond(201, { uploadUrl, key });
  };
}
