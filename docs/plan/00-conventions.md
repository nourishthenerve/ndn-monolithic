# Executor pack — conventions

**Before any task, the executor reads:** C-01–C-11, §6 of the brief, and this conventions file.

- **Stack:** TypeScript 5.x, Node 22 (arm64 Lambda), pnpm workspaces, CDK v2, Vitest, Playwright, Zod for runtime validation at every boundary.
- **Layout:** per §4 of the brief — `/apps/web`, `/apps/mobile`, `/packages/{api-client,shared-types,i18n,ui}`, `/services/{api,workers}`, `/infra`, `/tests/{integration,e2e,load}`, `/docs`.
- **Sizes:** S ≤ ~150 changed lines · M ≤ ~400 · **L = split it.**
- **Errors:** typed `AppError` with a stable `code`; never leak internals to responses; never log PII or clinical content — log identifiers only.
- **Logging:** structured JSON, one line per request, sampled. No `console.log`. No debug level in production.
- **Naming:** branches `feat/<milestone-id>-<slug>`; conventional commits; one task = one PR.
- **PR body must contain:** task ID, requirement IDs, what changed, test evidence (names + pass output), rollback steps, expected £ cost delta.
- **Time:** every timestamp stored as UTC instant; render Europe/London; **time is injectable — no test reads the wall clock.**
- **The prohibition:** no `DeleteItem`, `DeleteObject`, `TRUNCATE`, `DROP`, or destructive migration against protected stores — in application code, admin tools, scripts or test helpers. Soft-delete flags only.
