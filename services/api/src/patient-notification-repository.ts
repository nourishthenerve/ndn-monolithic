// 2026-09-01: "When a clinician/principal clinician edits a calender for a
// given patient it will appear as a notification on patients logged in
// dashboard."
//
// Bespoke, not `Repository<T>`-based — the same reason
// `message-repository.ts` and `appointment-repository.ts` are: a
// notification has no natural single opaque id (it is identified by
// `patientId` + a time-ordered suffix) and its access pattern is a
// newest-first `Query` over one partition, which a single-item
// `get`/`put` `KeyValueStore<T>` cannot express.
//
// ## No audit row, and that is a decision rather than an omission
//
// Every other repository in this codebase writes an `AUDIT#` row per
// mutation, and this one deliberately does not. An audit row answers "who
// did what to whom"; a notification is not a *what* — it is a system-
// generated echo of an action that has already been audited by the
// repository that performed it (`AppointmentRepository.schedule`,
// `.approve`, `.cancel`). Auditing the echo as well would double the
// volume of the log this practice's principal actually reads, and every
// row it added would name the same actor, the same instant and the same
// patient as the row above it, differing only in saying "and a notice was
// shown". Marking one read is the patient's own housekeeping on their own
// dashboard, and carries no fact anyone will ever need to reconstruct.
//
// The `AuditWriter` is therefore not a constructor parameter here — not
// passed and ignored, which would read as an oversight, but absent, which
// reads as the decision it is.
import { randomUUID } from 'node:crypto';

import type { PatientNotification, PatientNotificationKind } from '@ndn/shared-types';

import type { ActorContext } from './audit.js';
import type { Clock } from './clock.js';
import { unprojected, type Unprojected } from './projection.js';

export const PATIENT_NOTIFICATION_ENTITY_TYPE = 'patient-notification';

/** How many notices a dashboard asks for. A feed, not an archive — the patient's own page shows recent activity, and older rows stay queryable but unshown. */
export const PATIENT_NOTIFICATION_PAGE_SIZE = 20;

export interface PatientNotificationStore {
  /** Conditioned on not already existing, the same `attribute_not_exists(pk)` shape every other writer in this table uses — a uuid collision is refused, never an overwrite. */
  create(notification: PatientNotification): Promise<void>;
  /** Main-table `Query` on `PAT#<id>`, `begins_with(sk, 'NOTIF#')`, **newest first** — never a `Scan`. */
  listForPatient(patientId: string, limit: number): Promise<PatientNotification[]>;
  /** An atomic `UpdateItem` on `read` alone. Returns `undefined` when there is no such row rather than throwing, so a patient marking an already-gone notice read is a no-op, not a 500. */
  markRead(
    patientId: string,
    notificationId: string,
    now: string,
  ): Promise<PatientNotification | undefined>;
}

export interface PatientNotificationRepositoryOptions {
  /** Defaults to node:crypto's randomUUID — injectable so a test can assert on a known id, and so a test can force a collision. */
  readonly newId?: () => string;
}

export class PatientNotificationRepository {
  private readonly newId: () => string;

  constructor(
    private readonly store: PatientNotificationStore,
    private readonly clock: Clock,
    options: PatientNotificationRepositoryOptions = {},
  ) {
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * The write every calendar action reaches. `actor` is the person whose
   * action caused the notice — recorded as a `sub`, never a name, because
   * the dashboard renders "your clinician" from the relationship it
   * already knows, not from anything stored here.
   *
   * **Called only from a path that has already been authorised on the
   * `Appointments` or `Appointment approval` row.** There is no `can()`
   * call here and no HTTP route that reaches this method — the matrix's
   * `Patient notifications` row grants `C` to nobody at all, precisely so
   * that putting a notice on a patient's dashboard stays a consequence of
   * doing something rather than a thing that can be done.
   */
  async notify(
    patientId: string,
    kind: PatientNotificationKind,
    actor: ActorContext,
    about: { readonly subjectAt?: string } = {},
  ): Promise<Unprojected<PatientNotification>> {
    const now = this.clock.now().toISOString();
    const notification: PatientNotification = {
      patientId,
      // Time first so the sort key orders chronologically, then a uuid so
      // two events in the same millisecond are two rows rather than one
      // refused write.
      notificationId: `${now}#${this.newId()}`,
      kind,
      ...(about.subjectAt ? { subjectAt: about.subjectAt } : {}),
      actorId: actor.subjectId,
      read: false,
      created_at: now,
      updated_at: now,
      status: 'active',
    };
    await this.store.create(notification);
    return unprojected(notification);
  }

  async listForPatient(
    patientId: string,
    limit = PATIENT_NOTIFICATION_PAGE_SIZE,
  ): Promise<Unprojected<PatientNotification>[]> {
    const items = await this.store.listForPatient(patientId, limit);
    return items.map(unprojected);
  }

  /** `undefined` when the row is gone — see `PatientNotificationStore.markRead`. */
  async markRead(
    patientId: string,
    notificationId: string,
  ): Promise<Unprojected<PatientNotification> | undefined> {
    const updated = await this.store.markRead(
      patientId,
      notificationId,
      this.clock.now().toISOString(),
    );
    return updated ? unprojected(updated) : undefined;
  }
}
