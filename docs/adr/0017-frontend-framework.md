# ADR 0017 — Frontend framework

**Decision:** Astro (static output) with React islands, TypeScript, file-based i18n routing
**Options rejected:** Next.js (server runtime we don't need — everything Phase 1 ships is static/edge-cacheable, and a Node server contradicts D-08's S3+CloudFront model); plain hand-rolled HTML/CSS (no component reuse across ~20 pages, no i18n routing primitive); SPA framework alone, e.g. bare React/Vite (ships JS for content that doesn't need it, works against the WCAG/motion/perf budget in TASK 1.1.1)
**£/mo:** £0 — static build output drops into the S3 bucket + CloudFront distribution TASK 0.4.1 already deployed; no new AWS resource
**Reversal cost:** Low — output is static HTML/CSS/JS regardless of generator; no server-side lock-in
