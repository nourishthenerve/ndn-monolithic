// 2026-09-06: the homepage shows the three most recent posts, workshops and
// testimonials, while the three listing pages still show everything. That is
// one rule, applied by three islands, and this is it — written once so the
// edge cases are decided once rather than three times in a `.slice()`.
//
// The distinction that matters: **`undefined` is "no limit", `0` is "none".**
// An island's `limit` prop is optional, so an unset one must mean the
// listing page's own unlimited behaviour; a caller that genuinely passes `0`
// asked for an empty list and gets one. `slice(0, undefined)` already
// behaves this way, but only by accident of the `Array.prototype.slice`
// signature, and "by accident" is not something the listing pages should
// depend on.

/**
 * The first `limit` items, or every item when `limit` is `undefined`.
 *
 * A negative or fractional `limit` is clamped rather than trusted: these
 * values reach here from an Astro page's props, and the failure mode of a
 * bad one should be a sensible list, not `slice`'s own wrap-from-the-end
 * behaviour on a negative count.
 */
export function takeAtMost<T>(items: readonly T[], limit?: number): readonly T[] {
  if (limit === undefined || !Number.isFinite(limit)) {
    return items;
  }
  return items.slice(0, Math.max(0, Math.floor(limit)));
}
