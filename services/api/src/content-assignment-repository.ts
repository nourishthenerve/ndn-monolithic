// TASK 3.5.1: bespoke, not `Repository<T>`-based — the same reason
// `appointment-repository.ts` is: this entity has no natural single
// opaque id (it is identified by `patientId` + `contentId`), and its own
// read (a patient's whole assigned list) is a `Query`, not a single-item
// `get`/`put` `KeyValueStore<T>` can express.
//
// Depends on `ContentRepository` (TASK 1.3.1) directly — reused, not
// reimplemented, per this task's own "Do NOT: let this task re-specify
// anything Phase 1's ContentRepository already owns." The content item
// itself (title/body/translations) always lives at `CONTENT#<id>` /
// `META`; this file only ever reads it, never writes it.
import type { ContentAssignment, ContentItem } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import type { ContentRepository } from './content-repository.js';
import { AppError } from './errors.js';
import { unprojected, type Unprojected } from './projection.js';

export const CONTENT_ASSIGNMENT_ENTITY_TYPE = 'content-assignment';

export interface ContentAssignmentStore {
  /** Conditioned on not already existing (`attribute_not_exists(pk)` on the real implementation) — assigning the same content to the same patient twice is a no-op refusal, not a duplicate row. */
  create(assignment: ContentAssignment): Promise<void>;
  /** Main-table `Query` on `PAT#<id>`, `begins_with(sk, 'CONTENT#')` — never a `Scan`. */
  listForPatient(patientId: string): Promise<ContentAssignment[]>;
}

/** What the patient-facing read hands back — hydrated, never a bare id (this task's own DoD). */
export interface HydratedContentAssignment {
  readonly contentId: string;
  readonly assignedAt: string;
  readonly title: string;
  readonly excerpt: string;
}

export class ContentAssignmentRepository {
  constructor(
    private readonly store: ContentAssignmentStore,
    private readonly content: ContentRepository,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Only ever reaches this far when `can()` has already granted the
   * `'Sub-clinician (assigned)'` column (`authz-matrix.ts`'s `Content
   * assignment` row) — this method trusts the caller to have checked,
   * the same contract every other repository in this codebase keeps.
   */
  async assign(
    patientId: string,
    contentId: string,
    actor: ActorContext,
  ): Promise<Unprojected<ContentAssignment>> {
    const item = await this.content.findById(contentId);
    if (!item || item.status !== 'published') {
      throw new AppError(
        'CONTENT_NOT_PUBLISHED',
        `content ${contentId} does not exist or is not published`,
      );
    }
    const now = this.clock.now().toISOString();
    const assignment: ContentAssignment = {
      patientId,
      contentId,
      assignedAt: now,
      created_at: now,
      updated_at: now,
      status: 'active',
    };
    await this.store.create(assignment);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: CONTENT_ASSIGNMENT_ENTITY_TYPE,
        entityId: `${patientId}#${contentId}`,
      }),
    );
    return unprojected(assignment);
  }

  /**
   * Hydrated from `ContentRepository.findById` — title/excerpt, not a
   * bare `contentId` the frontend would need a second round trip to
   * resolve (this task's own DoD). `translations[defaultLocale]`:
   * `GET /content` (TASK 1.3.1) returns every locale's translation and
   * lets the frontend pick, but that precedent exists for a *public*,
   * cacheable list where every visitor's locale is unknown ahead of
   * time; here the server already knows there is exactly one supported
   * locale (`@ndn/i18n`'s own `Locale = 'en'`), so resolving it
   * server-side avoids the round trip that would otherwise cost. Revisit
   * once a second locale exists and "the caller's locale" becomes a real
   * question this method needs an actual answer to, not a formality.
   */
  async listForPatient(patientId: string): Promise<HydratedContentAssignment[]> {
    const assignments = await this.store.listForPatient(patientId);
    const hydrated: HydratedContentAssignment[] = [];
    for (const assignment of assignments) {
      const item = await this.content.findById(assignment.contentId);
      if (!item) {
        // Content is never deleted (00-conventions.md) — unreachable in
        // practice, kept as defence in depth rather than assumed away.
        continue;
      }
      const translation = translationFor(item);
      hydrated.push({
        contentId: assignment.contentId,
        assignedAt: assignment.assignedAt,
        title: translation.title,
        excerpt: translation.excerpt,
      });
    }
    return hydrated;
  }
}

function translationFor(item: ContentItem): { title: string; excerpt: string } {
  const translation = item.translations.en;
  return { title: translation.title, excerpt: translation.excerpt };
}
