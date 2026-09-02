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
  /**
   * 2026-09-02: an optional lead image, the blog counterpart of
   * `Workshop.posterKey` and stored the same way — a media-bucket object
   * key, never a URL, so the site builds its own `/media/…` path and the
   * record carries no host it could be wrong about.
   *
   * Optional because most posts will not have one and a required image
   * would make the common case do work for the rare one. Language-neutral,
   * sitting beside `translations` rather than inside it: one image serves
   * every locale, and asking an author for one per language would be
   * asking for the same file twice.
   */
  imageKey?: string;
  translations: Record<Locale, { title: string; body: string; excerpt: string }>;
}
