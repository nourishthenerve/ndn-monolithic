// 2026-09-06: the submit half of authoring, shared by the two composers.
//
// `AuthoringPanel.tsx` used to hold a blog form and a workshop form in one
// component, so this was two private helpers inside it. Splitting that panel
// into a page each — the owner's *"Split blog and workshops button"* — turned
// them into the one thing the two halves genuinely share: how a `Response`
// becomes a sentence, and where a create goes.
//
// Kept free of React and of JSX for this directory's usual reason: a test of
// which status code means what should not drag a form's markup into a
// coverage count.
import { contentApiUrl } from '../site-config.js';

/**
 * What a submit can end as.
 *
 * `conflict` and `invalid` are separate from `error` because the author can
 * do something about each of them and the something is different: a conflict
 * means this title is already taken, and an invalid means a field needs
 * fixing. Collapsing them into "something went wrong" is what makes a form
 * feel like it is refusing at random.
 */
export type SubmitStatus =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'conflict'
  | 'invalid'
  | 'forbidden'
  | 'error';

/** One response, one status. Both create routes answer with the same vocabulary. */
export async function statusFor(response: Response): Promise<SubmitStatus> {
  if (response.status === 401 || response.status === 403) return 'forbidden';
  if (response.status === 409) return 'conflict';
  if (response.status === 400) return 'invalid';
  return response.ok ? 'success' : 'error';
}

/** The two things the authoring surfaces create; each `AuthoredContentList` shows one. */
export type SavedContentKind = 'blog' | 'workshop';

/**
 * Dispatched on `window` after a blog post or workshop is created, so the
 * `AuthoredContentList` on the same page re-reads and shows the new row
 * without a manual refresh — the owner: *"I need to refresh the page to
 * update the table below … make it auto reload as soon as I save/publish."*
 *
 * A DOM event rather than shared React state because the composer and the
 * list are two separate Astro islands with no common parent to lift state
 * into — the same channel, and the same reasoning, as `ASSESSMENT_SAVED_EVENT`
 * in `AssessmentForm.tsx`. `detail.kind` says which list should care; a list
 * of the other kind ignores it (harmless if the two ever share a page).
 */
export const CONTENT_SAVED_EVENT = 'ndn:content-saved';

/**
 * Announce a successful create so a matching `AuthoredContentList` re-reads.
 * A no-op without a `window` — SSR, and the composer tests that run in the
 * node environment — so a caller never has to guard the DOM itself.
 */
export function announceContentSaved(kind: SavedContentKind): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(CONTENT_SAVED_EVENT, { detail: { kind } }));
}

/** A `POST` to the content API, authorised with the caller's own access token. */
export function post(path: string) {
  return (accessToken: string, body: unknown): Promise<Response> =>
    fetch(`${contentApiUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
}
