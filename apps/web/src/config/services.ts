// 2026-09-06: the services the landing page advertises, as data rather than
// markup — the same shape (and the same reasoning) as `legal-pages.ts` and
// `social-links.ts`. The homepage renders one tile per entry, so adding,
// reordering or removing a service is an edit to this array and nothing
// else. Zod-parsed eagerly at import time so a malformed entry fails
// `astro build` and every test that imports this module, rather than
// rendering a tile with an empty heading.
//
// ## 2026-09-13: the clinic's own eight topics, as circular tiles
//
// These replaced six placeholder rehab services once the clinic named what
// it offers. Each entry now carries an `icon` — the topic's illustration in
// `apps/web/public/` — because the "what we offer" section is a grid of
// circular emblems (icon in a disc, title underneath), two rows of four, not
// the description cards it used to be. There is no body copy any more: the
// title under the disc is the whole label. Swap an `id`, its
// `services.item.*.title` catalogue entry, and its `icon` together and the
// page follows without touching `index.astro`.
import { z } from 'zod';

export interface ServiceConfig {
  /** Stable identifier, and the middle segment of this entry's title i18n key. */
  readonly id: string;
  /** i18n key for the tile's heading. */
  readonly titleKey: string;
  /**
   * Public-root path to this topic's circular illustration. Decorative on the
   * page (`alt=""`) — the heading beside it already names the topic.
   */
  readonly icon: string;
}

export const serviceConfigSchema = z.object({
  // Lower-case and dash-free: the id is interpolated into a catalogue key,
  // where a stray dot would silently address a different namespace.
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9]*$/),
  titleKey: z.string().min(1),
  // A path from the public root (leading slash) to an `.svg` file — the shape
  // Astro serves `apps/web/public/*` at. `services.test.ts` additionally
  // proves each of these resolves to a file that actually exists.
  icon: z
    .string()
    .min(1)
    .regex(/^\/[\w./-]+\.svg$/),
});

/** The title key is derived from the id, so the two can never drift apart. */
function service(id: string, iconFile: string): ServiceConfig {
  return { id, titleKey: `services.item.${id}.title`, icon: `/${iconFile}` };
}

const rawServices: readonly ServiceConfig[] = [
  service('assessment', 'nourish_the_nerve_offer_comprehensive_assessment.svg'),
  service('psychosomatic', 'nourish_the_nerve_offer_psychosomatic_mind_body_care.svg'),
  service('neurorehab', 'nourish_the_nerve_offer_neurorehabilitation.svg'),
  service('stress', 'nourish_the_nerve_offer_stress_anxiety_nervous_system_regulation.svg'),
  service('womenshealth', 'nourish_the_nerve_offer_womens_health_life_stage_support.svg'),
  service('lifestyle', 'nourish_the_nerve_offer_lifestyle_preventive_health.svg'),
  service('childdevelopment', 'nourish_the_nerve_offer_child_development_family_wellbeing.svg'),
  service('valuesinformed', 'nourish_the_nerve_offer_values_informed_psychological_support.svg'),
];

export const services: readonly ServiceConfig[] = z
  .array(serviceConfigSchema)
  .min(1)
  .parse(rawServices);
