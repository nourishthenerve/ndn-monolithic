import { z } from 'zod';

// TASK 0.6.3: the first real use of Zod for "runtime validation at every
// boundary" (docs/plan/00-conventions.md) — /health's response is a public
// contract (also depended on by services/api/src/smoke-test.ts, though that
// handler only checks the status code, not the shape). Mirrors the literal
// object services/api/src/health.ts's handler serializes.
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string().min(1),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
