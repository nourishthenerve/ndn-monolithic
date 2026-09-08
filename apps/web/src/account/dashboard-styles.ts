// 2026-09-08: the account dashboard's own stylesheet.
//
// The owner: *"the buttons on the dashboard are all look quite basic, make
// them nice bootstrapped buttons."*
//
// Most of that request is answered in the components themselves — the panels'
// plain `<button>`s are now packages/ui's `Button`, so they are the same pill
// the rest of the site uses. This file is for the half that is **not** a
// button element at all.
//
// A principal clinician's dashboard ends in two `<nav>`s of links: patient
// accounts, clinician accounts, blog, workshops, testimonials. The owner has
// called those "buttons" from the day they were built — *"there are three
// buttons - patient accounts, clinician accounts and blog and workshops"*
// (2026-09-06) — and they are the last thing on the page, so "the buttons on
// the dashboard" cannot be read as excluding them. They were a bulleted list
// of underlined links.
//
// They stay `<a>`s. Each one navigates to a real URL, so it must open in a
// new tab on a middle-click and show its target on hover; what changes is
// that they are *drawn* as the controls they are read as. That is a
// stylesheet's job and not an element's, which is the same call
// `calendar-styles.ts` makes for its own join link.
//
// Held as an exported string for the reasons `calendar-styles.ts` and
// `caseload-styles.ts` are: unit-testable as text, injected by the page with
// one `<style set:html>` (this site's CSP admits no other kind), and out of
// the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would end
// it mid-stylesheet.

export const accountDashboardStylesCss = `
.ndn-account-nav {
  margin-block-start: 2rem;
}

/* A row of controls rather than a list of destinations. The bullets and the
   stacked layout were what made these read as a footnote to the dashboard
   instead of as its remaining actions. */
.ndn-account-nav ul {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 0-2-0 against packages/ui's own .ndn-link (0-1-0), which every Link
   carries and which sets the brand colour and an underline. Specificity
   rather than source order: this stylesheet and the primitive one are
   injected by different parts of the layout, and a rule that only wins
   because of where it happens to land is a rule that stops winning when
   something moves. Same reasoning, same shape, as the calendar's own
   join-call link. */
.ndn-account-nav .ndn-link {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  padding-block: 0.625rem;
  padding-inline: 1.375rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 999px;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-text);
  font-weight: 500;
  text-decoration: none;
  transition: border-color var(--ndn-motion-duration-fast) ease,
    background-color var(--ndn-motion-duration-fast) ease,
    color var(--ndn-motion-duration-fast) ease;
}

/* The outline variant's own hover, matched to .ndn-button--secondary so a
   dashboard carrying both reads as one family. The underline comes back on
   hover: these are still links, and losing every trace of that is how a
   control stops telling anyone where it goes. */
.ndn-account-nav .ndn-link:hover {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-wash);
  color: var(--ndn-color-brand-strong);
  text-decoration: underline;
}

.ndn-account-nav .ndn-link:active {
  transform: translateY(1px);
}
`;
