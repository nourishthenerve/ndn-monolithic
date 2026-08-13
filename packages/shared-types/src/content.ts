// TASK 1.3.1: docs/plan/04-data-model-rbac.md's content entity —
// `PK = CONTENT#<id>` / `SK = META` in the single-table design
// (services/api/src/content-repository.ts, infra/src/data-stack.ts).
// Per-language body lives on one row (`translations`), not one row per
// language, so a content item's full record is always a single read.
import type { Locale } from '@ndn/i18n';

import type { BaseRecord } from './types.js';

export type ContentStatus = 'draft' | 'published' | 'unpublished';

export interface ContentItem extends BaseRecord<ContentStatus> {
  id: string;
  contentType: 'blog';
  /** Never 'deleted' — unpublish (TASK 1.3.2) only ever transitions status. */
  status: ContentStatus;
  keywords: string[];
  translations: Record<Locale, { title: string; body: string; excerpt: string }>;
}
