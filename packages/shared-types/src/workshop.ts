// TASK 1.5.1: docs/plan/05-execution-plan.md's workshop entity —
// `PK = WORKSHOP#<id>` / `SK = META` in the same single-table design
// content.ts/testimonial.ts already use (services/api/src/workshop-repository.ts,
// infra/src/data-stack.ts). The first Phase 1 entity with real media: a
// poster image lives in web-stack.ts's MediaBucket under the `workshops/`
// prefix, referenced here only by its object key, never a full URL (the
// public site builds `/media/<posterKey>` itself — see
// apps/web/src/site-config.ts's workshopPosterUrl).
import type { Locale } from '@ndn/i18n';

import type { BaseRecord } from './types.js';

export type WorkshopStatus = 'draft' | 'published' | 'cancelled';

export interface Workshop extends BaseRecord<WorkshopStatus> {
  id: string;
  /** Never 'deleted' — cancel (TASK 1.5.1) only ever transitions status, same discipline as ContentItem/Testimonial. */
  status: WorkshopStatus;
  dateTimeUtc: string;
  capacity: number;
  /** GBP pence, per D-13 — never a float. */
  priceMinorUnits: number;
  posterKey?: string;
  details: Record<Locale, { title: string; description: string }>;
}
