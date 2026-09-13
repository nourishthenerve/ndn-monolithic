// 2026-09-13: the "what we offer" tiles, made interactive. The owner: *"when
// I click these logos a pop up should open with detailed info on these
// areas."*
//
// Why an island rather than markup in `index.astro`: opening a dialog needs
// client-side state, and this repo's CSP forbids the inline `onclick`/inline
// `<script>` that the static page would otherwise reach for (see the CSP note
// in index.astro and `csp-inline-scripts.test.ts`). So the tiles become a
// React island, exactly as the blog/workshop/testimonial strips already are —
// server-rendered into the HTML (so the titles and icons are there for a
// crawler and for a reader with no JavaScript) and hydrated to add the click.
//
// All the human-readable copy is resolved by `t()` in the page and passed in
// as props: nothing here is a hard-coded string (the `ndnI18n` lint rule that
// covers apps/web/** would flag it), and the island stays locale-agnostic.
//
// The styling lives with the rest of the section in `index.astro`'s stylesheet
// (`.ndn-home-offer*`, `.ndn-offer-dialog*`) rather than here — one place owns
// the section's look, and it keeps this file to behaviour.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface OfferTile {
  /** Stable id, from the service config — the key React lists by. */
  readonly id: string;
  /** The topic name, already localised. Shown under the disc and as the dialog heading. */
  readonly title: string;
  /** The longer copy shown in the dialog, already localised. */
  readonly detail: string;
  /** Public-root path to the topic's circular illustration (decorative). */
  readonly icon: string;
}

export interface OfferTilesProps {
  readonly offers: readonly OfferTile[];
  /** Localised label for the dialog's close button. */
  readonly closeLabel: string;
}

const TITLE_ID = 'ndn-offer-dialog-title';
const DETAIL_ID = 'ndn-offer-dialog-detail';

/**
 * The grid of topic tiles plus the single detail dialog they share. Clicking a
 * tile opens the dialog on that topic; Escape, the close button, or a click on
 * the backdrop closes it, and focus returns to the tile that opened it (all
 * from the native `<dialog>` element's `showModal()`).
 */
export function OfferTiles({ offers, closeLabel }: OfferTilesProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const active = offers.find((offer) => offer.id === openId) ?? null;

  // Drive the real dialog from state rather than the other way round:
  // `showModal()` (not `open`) is what puts the element in the top layer with a
  // backdrop, an inert background and a focus trap, none of which the `open`
  // attribute gives you.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (active !== null && !dialog.open) {
      dialog.showModal();
    } else if (active === null && dialog.open) {
      dialog.close();
    }
  }, [active]);

  return (
    <>
      <ul className="ndn-home-offers" role="list">
        {offers.map((offer) => (
          <li key={offer.id}>
            <button
              type="button"
              className="ndn-home-offer"
              aria-haspopup="dialog"
              onClick={() => setOpenId(offer.id)}
            >
              <span className="ndn-home-offer-disc">
                {/* Decorative: the label below is the tile's accessible name. */}
                <img src={offer.icon} alt="" width={144} height={144} loading="lazy" />
              </span>
              <span className="ndn-home-offer-label">{offer.title}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* One dialog, reused for whichever tile is open. `onClose` catches every
          way it can close (Escape included) and syncs state back; the onClick
          closes it when the click lands on the backdrop (the dialog element
          itself) rather than on its content. */}
      <dialog
        ref={dialogRef}
        className="ndn-offer-dialog"
        aria-labelledby={TITLE_ID}
        aria-describedby={DETAIL_ID}
        onClose={() => setOpenId(null)}
        onClick={(event) => {
          if (event.target === dialogRef.current) setOpenId(null);
        }}
      >
        {active !== null && (
          <div className="ndn-offer-dialog-inner">
            <span className="ndn-home-offer-disc ndn-offer-dialog-disc">
              <img src={active.icon} alt="" width={144} height={144} />
            </span>
            <h2 id={TITLE_ID} className="ndn-offer-dialog-title">
              {active.title}
            </h2>
            <p id={DETAIL_ID} className="ndn-offer-dialog-detail">
              {active.detail}
            </p>
            <button
              type="button"
              className="ndn-offer-dialog-close"
              onClick={() => setOpenId(null)}
            >
              {closeLabel}
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}
