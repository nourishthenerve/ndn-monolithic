// TASK 1.4.2: the HTTP boundary for POST /testimonials (infra/src/data-stack.ts)
// — same split as contact-form.ts/contact-form-handler.ts: testimonial-submission.ts
// carries the gate-in-order logic and is fully unit-testable with injected
// deps; everything below this file's own HTTP handler export is the
// once-per-cold-start AWS wiring (SSM secret, real DynamoDB-backed store)
// that only this file touches.
import { createHash, randomUUID } from 'node:crypto';

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { z } from 'zod';

import { actorContext, hashSourceIp, requestOriginOf } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { TestimonialRepository } from './testimonial-repository.js';
import {
  TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL,
  TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
  createTestimonialSubmissionHandler,
} from './testimonial-submission.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.js';

// TASK 1.4.2: the fixed consent-statement version shown to every submitter
// on the testimonials page (apps/web/src/pages/[locale]/testimonials/index.astro)
// — bump this alongside that page's consent copy so a future dispute can
// identify which wording a given testimonial's consent record refers to.
export const TESTIMONIAL_CONSENT_TEXT_VERSION = '2026-08-14';

const submitTestimonialBodySchema = z
  .object({
    quote: z.string().min(1).max(2000),
    attributionDisplay: z.enum(['full', 'firstNameOnly', 'anonymous']),
    attributionName: z.string().min(1).max(200).optional(),
    // Used only to derive consent.submitterContactHash below — never stored
    // or logged as plaintext (00-conventions.md: "never log PII... log
    // identifiers only", same discipline contact-form-handler.ts's
    // hashSourceIp follows for the caller's IP).
    contactEmail: z.email().max(320),
    turnstileToken: z.string().min(1),
  })
  .refine((body) => body.attributionDisplay === 'anonymous' || body.attributionName !== undefined, {
    message: 'attributionName is required unless attributionDisplay is anonymous',
  });

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function hashContactEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

const TESTIMONIAL_SUBMISSION_LOG_SAMPLE_RATE = 1;

export interface TestimonialSubmissionHttpDeps {
  readonly flags: FlagReader;
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly repository: TestimonialRepository;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Defaults to node:crypto's randomUUID — injectable so tests can assert on a known id. */
  readonly generateId?: () => string;
}

export function createTestimonialSubmissionHttpHandler(
  deps: TestimonialSubmissionHttpDeps,
): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ??
    createSampledLogger({ clock, sampleRate: TESTIMONIAL_SUBMISSION_LOG_SAMPLE_RATE });
  const generateId = deps.generateId ?? randomUUID;
  const handleSubmission = createTestimonialSubmissionHandler({
    verifyTurnstile: deps.verifyTurnstile,
    rateLimiter: deps.rateLimiter,
    repository: deps.repository,
  });

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Flag: testimonials.submission.enabled — default off, same
    // "invisible until ready" convention as content.authoring.enabled.
    if (!(await deps.flags.isEnabled('testimonials.submission.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    // Zod first, before Turnstile is ever checked — same ordering
    // contact-form-handler.ts uses.
    const parsed = submitTestimonialBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const principal = hashSourceIp(event.requestContext.http.sourceIp);
    const result = await handleSubmission({
      data: {
        id: generateId(),
        // Only 'en' is populated at submission — same single-locale
        // reality content-authoring.ts's translationsSchema already
        // accepts (packages/i18n's supportedLocales is `['en']` today).
        quote: { en: parsed.data.quote },
        attribution: {
          display: parsed.data.attributionDisplay,
          ...(parsed.data.attributionName ? { name: parsed.data.attributionName } : {}),
        },
        consent: {
          textVersion: TESTIMONIAL_CONSENT_TEXT_VERSION,
          submitterContactHash: hashContactEmail(parsed.data.contactEmail),
        },
      },
      turnstileToken: parsed.data.turnstileToken,
      principal,
      // TASK 2.1.3: the same hash, now carried as the audit trail's actor
      // alongside the request it arrived on. `role: 'public'` is the
      // honest answer for an unauthenticated visitor — see audit.ts's
      // AuditActorRole for why the three non-`Role` members exist.
      actor: actorContext({ subjectId: principal, role: 'public' }, requestOriginOf(event)),
    });

    switch (result.kind) {
      case 'submitted':
        return respond(201, { status: 'submitted' });
      case 'blocked':
        return respond(result.reason === 'rateLimited' ? 429 : 400, {
          error: result.reason === 'rateLimited' ? 'RATE_LIMITED' : 'TURNSTILE_FAILED',
        });
    }
  };
}

// --- AWS wiring below: the only part of this file real Lambda traffic
// exercises that isn't covered by testimonial-submission-handler.test.ts's
// injected deps. ---

// Mirrors infra/src/config.ts's TURNSTILE_SECRET_PARAMETER_NAME — the same
// Turnstile widget/secret the contact form uses (contact-form-handler.ts),
// reused rather than a second Turnstile setup.
const TURNSTILE_SECRET_PARAMETER_NAME =
  process.env.TURNSTILE_SECRET_PARAMETER_NAME ?? '/ndn/turnstile-secret-key';

const ssmClient = new SSMClient({});

// Same cold-start caching convention as contact-form-handler.ts's
// cachedSecretPromise.
let cachedSecretPromise: Promise<string> | undefined;

function getTurnstileSecret(): Promise<string> {
  cachedSecretPromise ??= ssmClient
    .send(new GetParameterCommand({ Name: TURNSTILE_SECRET_PARAMETER_NAME, WithDecryption: true }))
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${TURNSTILE_SECRET_PARAMETER_NAME} has no value`);
      }
      return value;
    })
    .catch((error: unknown) => {
      cachedSecretPromise = undefined;
      throw error;
    });
  return cachedSecretPromise;
}

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

// One rate limiter per warm Lambda container — resets on cold start, same
// accepted limitation contact-form-handler.ts's own rateLimiter carries.
const rateLimiter: RateLimiter = new InMemoryRateLimiter({
  clock: systemClock,
  limit: TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL,
  windowMs: TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
});

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

// TASK 2.1.3: the durable audit sink. `AUDIT_TABLE_NAME` is the same table
// every store above writes to (infra/src/data-stack.ts sets all of them to
// NdnDataStack's table name) — named separately because the audit
// partition is the one this function's IAM grant is reasoned about
// independently of.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new TestimonialRepository(testimonialStore, auditLog, systemClock);

const verifyTurnstile: TurnstileVerifier = async (token) => {
  const secretKey = await getTurnstileSecret();
  return createTurnstileVerifier({ secretKey })(token);
};

export const handler = createTestimonialSubmissionHttpHandler({
  flags,
  verifyTurnstile,
  rateLimiter,
  repository,
});
