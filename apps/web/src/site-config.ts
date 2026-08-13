// TASK 1.1.1: minimal, real page metadata — grows into BaseLayout's config
// in TASK 1.2.1. `siteName` is the clinic's proper name/trademark, not
// translatable prose, so it stays a plain constant; the description IS
// user-facing copy and is a catalogue entry (`site.description`,
// packages/i18n/src/locales/en.json) fetched via `t()` instead, per D-04.

export const siteName = 'Nourish the Nerve';
