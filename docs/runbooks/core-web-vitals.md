# Core Web Vitals measurement

**Date:** 2026-08-21 · **Task:** [05-execution-plan.md § TASK 1.6.1](../plan/05-execution-plan.md), whose steps 1 and 5 both call for this check · **Gate:** G1 ("apex serving new site, legacy retired, **Core Web Vitals pass**") · **Requirements:** NFR-06

## Why this exists

Gate G1 names a Core Web Vitals pass as one of its three criteria, and TASK 1.6.1's Verification line requires "a Core Web Vitals run against the live apex [that] passes Gate G1's bar". The [Gate G1 review](../plan/gate-g1-report.md) §7 found that criterion **unmeasurable** — no Lighthouse tooling existed in the repo — and recorded it as formally unmet rather than substituting a weaker proxy. This closes that.

## The bar — defined here, because the plan never did

The plan says "Gate G1's bar" without giving numbers anywhere. Rather than leave it to interpretation at each gate, the bar is Google's own "good" Core Web Vitals thresholds, plus the Lighthouse category scores:

| Assertion | Threshold | Why |
|---|---|---|
| Performance category | ≥ 0.90 | Lighthouse's own "good" band |
| Accessibility category | **= 1.00** | Stricter than Lighthouse's default on purpose — FR-X-02 and TASK 1.1.3 already hold this site to zero serious/critical axe findings, so anything less here is a regression, not a near-miss |
| Largest Contentful Paint | ≤ 2500 ms | Google's "good" LCP |
| Cumulative Layout Shift | ≤ 0.10 | Google's "good" CLS |
| Total Blocking Time | ≤ 200 ms | Lab stand-in for INP — see below |
| First Contentful Paint | ≤ 1800 ms | Google's "good" FCP |

**On INP:** Interaction to Next Paint is a *field* metric — it needs real user interactions, which a lab run has none of. Lighthouse does not report it, and no lab tool can. Total Blocking Time is the standard lab proxy and is what is asserted here. Treating a TBT pass as an INP pass is an approximation, and worth remembering as one; real INP only becomes observable once the apex serves real traffic (and then only through field data, e.g. CrUX, which needs enough traffic to report at all).

Encoded in `lighthouserc.json`, so the bar is versioned and reviewable rather than re-argued.

## How to run it

```bash
pnpm cwv
```

Needs Chrome on the machine (`CHROME_PATH` if it is not in the default location — on macOS,
`CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`). Three runs per URL, median reported; `--collect.numberOfRuns=1` for a quick check. HTML and JSON reports land in `.lighthouseci/` (gitignored).

**Deliberately not wired into CI.** It measures a live deployed URL, so on a PR it would measure `main`'s site, not the PR's — a green check that proves nothing about the change under review. The job that *could* measure a PR's own build is `pr-environment`, which is currently paused ([ephemeral-pr-environments.md](ephemeral-pr-environments.md)). Run this at gates, before and after the apex cutover, and whenever a change lands that could plausibly affect page weight.

## Baseline — 2026-08-21, `next.nourishthenerve.com`, desktop preset

All six pages pass every assertion, with a great deal of headroom:

| Route | Perf | A11y | Best practices | SEO | LCP | FCP | CLS | TBT |
|---|---|---|---|---|---|---|---|---|
| `/en` | 100 | 100 | 96 | 100 | 327 ms | 327 ms | 0.001 | 0 ms |
| `/en/about` | 100 | 100 | 96 | 100 | 285 ms | 285 ms | 0.001 | 0 ms |
| `/en/blog` | 100 | 100 | 96 | 100 | 324 ms | 284 ms | 0.001 | 0 ms |
| `/en/workshops` | 100 | 100 | 96 | 100 | 285 ms | 285 ms | 0.001 | 0 ms |
| `/en/testimonials` | 100 | 100 | 96 | 100 | 412 ms | 325 ms | 0.010 | 0 ms |
| `/en/contact` | 100 | 100 | 96 | 100 | 414 ms | 289 ms | 0.001 | 0 ms |

LCP is 6–9× inside the 2500 ms budget and TBT is zero everywhere. That is what a static Astro build on CloudFront with self-hosted fonts (TASK 1.2.3) and no client-side framework should look like, and it is the shape ADR-0017 chose the stack for.

**Read this as a floor, not a forecast.** Every dynamic feature is currently flag-off ([gate-g1-report.md](../plan/gate-g1-report.md) §3a), so `/en/blog`, `/en/workshops` and `/en/testimonials` render empty lists, and none of these pages fetches anything. The numbers will move when real content, workshop posters and testimonial text land — images especially are the usual LCP regression. **Re-run this after the first real content is published**, not only at the next gate; that is the run that tells you something you do not already know.

Two further limits on what this baseline proves: it is `next.`, not the apex (the cutover is blocked — [g1-cutover.md](g1-cutover.md)), though both are served by the same CloudFront distribution and the same S3 origin, so the apex should measure identically once it is live; and it is the desktop preset, so it says nothing about a throttled mobile connection.

## Finding — no favicon (the only point docked anywhere)

Best practices scores 96, not 100, on **every** page, for one reason: `GET /favicon.ico` returns 404, which Chrome logs as a console error. There is no `apps/web/public/` directory, no icon asset, and no `<link rel="icon">` in `BaseLayout.astro` — it was never added, rather than added and broken.

Cosmetically this means a blank default icon in every browser tab and bookmark. It is a two-minute fix once an icon exists, and the icon is a brand decision for the site owner rather than something to invent here. **Owner action:** supply a square logo/mark; then add `apps/web/public/favicon.ico` (plus an SVG and an apple-touch-icon) and the corresponding `<link>` tags, and this score goes to 100.

## Cost

£0.00 — `@lhci/cli` is a dev dependency that runs locally against an already-deployed site. No AWS resource, no CI minutes (not wired into CI, above).
