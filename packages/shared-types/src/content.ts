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
  /**
   * 2026-09-07: when this post first went live, which is what a reader
   * means by "the date on the article" — the owner: *"for blog post and
   * workshops also show the date of publication on the thumbnail box."*
   *
   * **Not `created_at`, and not `updated_at`.** `created_at` is when the
   * draft was started, which for a post written over a week is a date the
   * article never had; `updated_at` moves every time a typo is fixed, and
   * a post that appeared to be published afresh each time it was corrected
   * would be lying about its own history.
   *
   * Stamped once, on the transition into `published` (or at creation, when
   * the authoring form publishes immediately — which it does by default),
   * and **kept across an unpublish/republish**: that is the same article
   * going back up, not a new one.
   *
   * Optional because every post written before this date has none. The
   * site falls back to `created_at` for those rather than showing nothing
   * — see `apps/web/src/publication-date.ts`, which is the only place that
   * fallback is expressed.
   */
  publishedAt?: string;
  translations: Record<Locale, { title: string; body: string; excerpt: string }>;
}
