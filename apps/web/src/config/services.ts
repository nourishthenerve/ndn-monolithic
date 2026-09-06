// 2026-09-06: the services the landing page advertises, as data rather than
// markup — the same shape (and the same reasoning) as `legal-pages.ts` and
// `social-links.ts`. The homepage renders one card per entry, so adding,
// reordering or removing a service is an edit to this array and nothing
// else. Zod-parsed eagerly at import time so a malformed entry fails
// `astro build` and every test that imports this module, rather than
// rendering a card with an empty heading.
//
// **The copy is not the clinic's own yet.** The catalogue had exactly one
// sentence about services before this file existed ("clinician-led
// neuro-rehabilitation support tailored to each patient's needs") and no
// list at all. These six are a plausible starting set for a
// neuro-rehabilitation clinic, written to be replaced: swap the `id`s and
// their two `services.item.*` catalogue entries for the real ones and the
// page follows without touching `index.astro`.
import { z } from 'zod';

export interface ServiceConfig {
  /** Stable identifier, and the middle segment of this entry's two i18n keys. */
  readonly id: string;
  /** i18n key for the card's heading. */
  readonly titleKey: string;
  /** i18n key for the card's one-line description. */
  readonly bodyKey: string;
}

export const serviceConfigSchema = z.object({
  // Lower-case and dash-free: the id is interpolated into a catalogue key,
  // where a stray dot would silently address a different namespace.
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9]*$/),
  titleKey: z.string().min(1),
  bodyKey: z.string().min(1),
});

/** Every entry's keys are derived from its id, so the two can never drift apart. */
function service(id: string): ServiceConfig {
  return { id, titleKey: `services.item.${id}.title`, bodyKey: `services.item.${id}.body` };
}

const rawServices: readonly ServiceConfig[] = [
  service('assessment'),
  service('physiotherapy'),
  service('occupational'),
  service('speech'),
  service('cognitive'),
  service('carers'),
];

export const services: readonly ServiceConfig[] = z
  .array(serviceConfigSchema)
  .min(1)
  .parse(rawServices);
