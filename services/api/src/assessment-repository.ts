// TASK 3.3.1: one `VersionedRepository<Assessment>`, the same pattern
// clinical-record-repository.ts already established for diagnosis/care
// plan — except an assessment versions per *named form*, not per patient
// alone, so every method here takes a `patientId` and an `assessmentId`
// and combines them into the one composite `id` `VersionedRepository`
// itself knows about.
//
// ## 2026-09-01 — instantiation, and the carry-forward rule
//
// Two methods are new, and between them they are why a four-section form
// with four different sets of writers can still be append-only:
//
//   * `instantiate` — "Each patient will have an assessment form that will
//     be loaded from the template the moment his account is being
//     created." Version 1, every section present and empty except the tag
//     the account was created with. **Idempotent**, the same property and
//     for the same reason `PatientRepository.register` is: it is called
//     from inside `POST /patients`, whose Lambda invocation can be
//     retried, and a second call must return the existing form rather
//     than throwing or overwriting a form someone has since filled in.
//   * `applySectionPatch` — the write every HTTP caller actually reaches.
//     It takes *only the sections the caller was authorised for* and
//     carries every other section forward from the previous version
//     byte-for-byte.
//
// **The carry-forward is what makes section permissions and append-only
// versioning compatible at all,** and it is worth stating plainly because
// the obvious alternative is a security hole. If a writer had to send the
// whole record — the shape a naive "POST a new version" API would have —
// then a patient editing their general info would have to send back the
// clinician's private section, which they cannot read and therefore
// cannot send. Every such API ends up either denying the patient the edit
// or letting the client round-trip a section it never saw. Here the
// previous version is read server-side and the caller's patch is laid over
// it, so a section a caller cannot read is a section they cannot name,
// cannot resend, and cannot destroy by omitting.
import type {
  Assessment,
  AssessmentAttachment,
  AssessmentSection,
  AssessmentValue,
  FieldSet,
  PatientTag,
} from '@ndn/shared-types';
import {
  ASSESSMENT_TAG_FIELD_ID,
  ASSESSMENT_TEMPLATE_ID,
  emptyAssessmentSection,
} from '@ndn/shared-types';

import type { ActorContext, AuditWriter } from './audit.js';
import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import type { Clock } from './clock.js';
import type { Unprojected } from './projection.js';
import type { KeyValueStore } from './store.js';
import { VersionedRepository } from './versioned-repository.js';

/** The assessment id every patient's form is created under today. One template, one form per patient; a second named form is additive. */
export const DEFAULT_ASSESSMENT_ID = ASSESSMENT_TEMPLATE_ID;

/**
 * One section's worth of change. `responses` is **merged** over the
 * previous version's, never substituted: a caller who omits a field is
 * saying nothing about it, not clearing it. `addAttachments` appends, and
 * is the only way an attachment ever enters the record — a client cannot
 * send an attachment *list*, so it cannot rewrite, reorder or drop one
 * that is already there, nor forge the `uploadedBy`/`uploadedAt` stamps
 * this file writes itself.
 */
export interface AssessmentSectionPatch {
  readonly responses?: Readonly<Record<string, AssessmentValue>>;
  readonly addAttachments?: readonly NewAttachment[];
}

/** What a caller may say about a file it has just uploaded. Never `uploadedAt`/`uploadedBy`. */
export interface NewAttachment {
  readonly key: string;
  readonly fileName: string;
  readonly contentType: string;
}

export type AssessmentPatch = Partial<Readonly<Record<FieldSet, AssessmentSectionPatch>>>;

/**
 * `VersionedRepository`'s own `id` is one string; this class is what
 * turns "which patient, which named form" into that one string and back
 * — `${patientId}#${assessmentId}`, unambiguous because a patient id is a
 * Cognito `sub` (a UUID, never containing `#`), the same guarantee
 * `caseload-repository.ts`'s own GSI3 parsing already relies on.
 */
function compositeId(patientId: string, assessmentId: string): string {
  return `${patientId}#${assessmentId}`;
}

/** One section, patched. Pure — no clock, no identity: both are passed in, so the same inputs always give the same section. */
function patchSection(
  previous: AssessmentSection,
  patch: AssessmentSectionPatch,
  stamp: { readonly at: string; readonly by: string },
): AssessmentSection {
  const added: AssessmentAttachment[] = (patch.addAttachments ?? []).map((attachment) => ({
    key: attachment.key,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    uploadedAt: stamp.at,
    uploadedBy: stamp.by,
  }));
  return {
    responses: { ...previous.responses, ...patch.responses },
    attachments: [...previous.attachments, ...added],
  };
}

export class AssessmentRepository {
  private readonly versioned: VersionedRepository<Assessment>;

  constructor(
    store: KeyValueStore<Assessment>,
    audit: AuditWriter,
    private readonly clock: Clock,
  ) {
    this.versioned = new VersionedRepository<Assessment>(
      store,
      audit,
      clock,
      ASSESSMENT_ENTITY_TYPE,
    );
  }

  getVersion(
    patientId: string,
    assessmentId: string,
    version: number,
  ): Promise<Unprojected<Assessment> | undefined> {
    return this.versioned.getVersion(compositeId(patientId, assessmentId), version);
  }

  listVersions(patientId: string, assessmentId: string): Promise<Unprojected<Assessment>[]> {
    return this.versioned.listVersions(compositeId(patientId, assessmentId));
  }

  /** The newest version, or `undefined` when the form has never been instantiated. `listVersions` is oldest-first, so this is its last element. */
  async latest(
    patientId: string,
    assessmentId: string,
  ): Promise<Unprojected<Assessment> | undefined> {
    const versions = await this.listVersions(patientId, assessmentId);
    return versions.at(-1);
  }

  /**
   * Version 1, from the template. Called by `POST /patients` immediately
   * after the patient record is written — see this file's header on why it
   * is idempotent, and docs/plan/04-data-model-rbac.md on why creating the
   * form is part of creating the account rather than a separately
   * authorised act on the assessment rows.
   *
   * `private{}` is deliberately absent from a fresh form, not present and
   * empty: `Assessment['private']`'s own doc has said since TASK 3.3.1
   * that it exists only on a version a clinician actually put something
   * in, and an always-present empty object would make "no clinician has
   * written here" indistinguishable from "a clinician wrote nothing".
   */
  async instantiate(
    patientId: string,
    assessmentId: string,
    actor: ActorContext,
    seed: { readonly tag?: PatientTag },
  ): Promise<Unprojected<Assessment>> {
    const existing = await this.getVersion(patientId, assessmentId, 1);
    if (existing) {
      return existing;
    }
    return this.versioned.createVersion(compositeId(patientId, assessmentId), 1, actor, {
      patientId,
      assessmentId,
      general: {
        responses: seed.tag ? { [ASSESSMENT_TAG_FIELD_ID]: seed.tag } : {},
        attachments: [],
      },
      patient: emptyAssessmentSection(),
      calendar: emptyAssessmentSection(),
    });
  }

  /**
   * A new version, built from `previous` with `patch`'s sections laid over
   * it. **The caller has already checked `can()` for every section named
   * in `patch`** — the same contract every repository in this codebase
   * keeps, and the reason this method takes a previous version rather than
   * re-reading one: the handler read it in order to decide `create` vs
   * `update` per section, and re-reading here could see a different record
   * than the one those decisions were made against.
   *
   * `version` is caller-supplied and the write is conditioned on it not
   * existing, which is this entity's optimistic concurrency: two staff
   * editing the same form both compute `latest + 1`, and the second one
   * gets a 409 rather than silently discarding the first one's section.
   */
  async applySectionPatch(
    previous: Unprojected<Assessment>,
    version: number,
    actor: ActorContext,
    patch: AssessmentPatch,
  ): Promise<Unprojected<Assessment>> {
    const stamp = { at: this.clock.now().toISOString(), by: actor.subjectId };
    // Built section by section rather than by spreading `patch` over
    // `previous`: a spread would carry any stray key the patch happened to
    // hold onto the record, and the four sections are the whole of what
    // this method may change.
    const next = {
      patientId: previous.patientId,
      assessmentId: previous.assessmentId,
      general: patchSection(previous.general, patch.general ?? {}, stamp),
      patient: patchSection(previous.patient, patch.patient ?? {}, stamp),
      calendar: patchSection(previous.calendar, patch.calendar ?? {}, stamp),
      // The one section that may be absent, and it stays absent unless it
      // already existed or this patch is the one creating it. Writing an
      // empty `private{}` onto every version would put the attribute on
      // records no clinician has touched — see `instantiate` above.
      ...(previous.private || patch.private
        ? {
            private: patchSection(
              previous.private ?? emptyAssessmentSection(),
              patch.private ?? {},
              stamp,
            ),
          }
        : {}),
    };
    return this.versioned.createVersion(
      compositeId(previous.patientId, previous.assessmentId),
      version,
      actor,
      next,
    );
  }
}
