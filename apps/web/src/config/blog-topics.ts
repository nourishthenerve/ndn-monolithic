// 2026-09-14: the "Topics" section on the landing page — the twelve blog
// themes as circular tiles, styled exactly like "what we offer" (an
// illustration in a disc with its title underneath). The owner named these as
// the same twelve tags a post is filed under, so the source of truth for both
// the ids and their order is `@ndn/shared-types`'s `blogThemeIds`, and the
// human label is the same `blog.theme.<id>` catalogue entry the checklist and
// the tags already use — one label per topic, everywhere.
//
// This file adds the one thing a theme id does not already carry: the topic's
// illustration in `apps/web/public/`. Same shape and reasoning as
// `services.ts`. Unlike a "what we offer" tile, a topic tile is a *link* — to
// `/{locale}/blog/topic/{id}`, the archive of every post carrying that theme —
// not a dialog, so there is no detail copy here.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { blogThemeIds } from '@ndn/shared-types';
import type { BlogThemeId } from '@ndn/shared-types';
import { z } from 'zod';

import { blogThemeLabelKey } from './blog-themes.js';

export interface BlogTopic {
  readonly id: BlogThemeId;
  /** The topic name, localised — the same string shown as a tag on a card. */
  readonly label: string;
  /** Public-root path to the topic's circular illustration (decorative on the tile). */
  readonly icon: string;
  /** Where the tile links: the archive of posts carrying this theme. */
  readonly href: string;
}

// The illustration file for each theme id. A `Record` keyed by the id union,
// so leaving one out — or adding a thirteenth theme without an image — is a
// compile error here rather than a missing picture on the page.
const topicIconFileByThemeId: Record<BlogThemeId, string> = {
  'anxiety-stress-nervous-system': 'nourish_the_nerve_topic_anxiety-stress.svg',
  neurorehabilitation: 'nourish_the_nerve_topic_pns-neurorehab.svg',
  'pain-science': 'nourish_the_nerve_topic_pain-science.svg',
  'migraine-headache-nervous-system': 'nourish_the_nerve_topic_migraine-ha-ns.svg',
  'stress-management-nervous-system-health':
    'nourish_the_nerve_topic_stress-management-ns-health.svg',
  'mental-health-and-brain': 'nourish_the_nerve_topic_mental-health-brain.svg',
  'womens-health': 'nourish_the_nerve_topic_womens-health.svg',
  'lifestyle-medicine': 'nourish_the_nerve_topic_lifestyle-medicine.svg',
  'nutrition-brain-nerve-health': 'nourish_the_nerve_topic_nutrition-brain-health.svg',
  'healthy-brain-longevity': 'nourish_the_nerve_topic_healthy-brain-longevity.svg',
  'child-development-family-health': 'nourish_the_nerve_topic_child-development-family-health.svg',
  'ask-the-doctor-myth-busting': 'nourish_the_nerve_topic_myth-busting-ask-the-doctor.svg',
};

// A path from the public root (leading slash) to an `.svg` file — the shape
// Astro serves `apps/web/public/*` at, the same guard `services.ts` uses.
// `blog-topics.test.ts` additionally proves each resolves to a real file.
const iconPathSchema = z
  .string()
  .regex(/^\/[\w./-]+\.svg$/, { message: 'a topic icon must be a public-root .svg path' });

/** The public-root path to a topic's illustration, validated once at import. */
export function topicIconPath(id: BlogThemeId): string {
  return iconPathSchema.parse(`/${topicIconFileByThemeId[id]}`);
}

/** The archive URL for one topic — every published post carrying this theme. */
export function topicHref(locale: Locale, id: BlogThemeId): string {
  return `/${locale}/blog/topic/${id}`;
}

/**
 * The twelve topics in the catalogue's own order (`blogThemeIds`) — id,
 * localised label, icon path and link target. The homepage renders one tile
 * per entry, and the topic page reads its heading from the entry whose id
 * matches the route.
 */
export function blogTopics(locale: Locale): readonly BlogTopic[] {
  return blogThemeIds.map((id) => ({
    id,
    label: t(blogThemeLabelKey(id), undefined, locale),
    icon: topicIconPath(id),
    href: topicHref(locale, id),
  }));
}
