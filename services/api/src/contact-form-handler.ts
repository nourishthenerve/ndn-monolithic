// TASK 1.4.1: the HTTP boundary for POST /contact (infra/src/web-stack.ts)
// — same split as content-authoring.ts/-handler.ts: `createContactFormHttpHandler`
// carries the real logic (flag gate, Zod validation, IP hashing, response
// shaping) and is fully unit-testable with injected deps; everything below
// its own export is the once-per-cold-start AWS wiring (SSM secret, real
// SES client, real fetch) that only this file touches.
import { createHash } from 'node:crypto';

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { z } from 'zod';

import { systemClock, type Clock } from './clock.js';
import {
  CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL,
  CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
  createContactFormHandler,
} from './contact-form.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { createSesContactEmailSender, type EmailSender } from './ses.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.js';

const contactBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email().max(320),
  message: z.string().min(1).max(5000),
  turnstileToken: z.string().min(1),
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

// The rate limiter's `principal` — SHA-256 of the caller's source IP.
// Never the raw address itself: not passed to contact-form.ts beyond this
// hash, and never logged (00-conventions.md: "never log PII... log
// identifiers only" — a one-way hash is exactly that).
function hashSourceIp(sourceIp: string): string {
  return createHash('sha256').update(sourceIp).digest('hex');
}

const CONTACT_FORM_LOG_SAMPLE_RATE = 1;

export interface ContactFormHttpDeps {
  readonly flags: FlagReader;
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly sendEmail: EmailSender;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createContactFormHttpHandler(deps: ContactFormHttpDeps): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CONTACT_FORM_LOG_SAMPLE_RATE });
  const handleContact = createContactFormHandler({
    verifyTurnstile: deps.verifyTurnstile,
    rateLimiter: deps.rateLimiter,
    sendEmail: deps.sendEmail,
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

    // Flag: contact.form.enabled — default off, same "invisible until
    // ready" convention as content.authoring.enabled.
    if (!(await deps.flags.isEnabled('contact.form.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    // Zod first, before Turnstile is ever checked (or any AWS call made) —
    // an oversized/missing field is a 400 on its own, not a wasted
    // siteverify round trip.
    const parsed = contactBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const principal = hashSourceIp(event.requestContext.http.sourceIp);
    const result = await handleContact({ ...parsed.data, principal });

    switch (result.kind) {
      case 'sent':
        return respond(200, { status: 'sent' });
      case 'blocked':
        return respond(result.reason === 'rateLimited' ? 429 : 400, {
          error: result.reason === 'rateLimited' ? 'RATE_LIMITED' : 'TURNSTILE_FAILED',
        });
    }
  };
}

// --- AWS wiring below: the only part of this file real Lambda traffic
// exercises that isn't covered by contact-form-handler.test.ts's injected
// deps. ---

// Mirrors infra/src/config.ts's TURNSTILE_SECRET_PARAMETER_NAME — that
// constant is what web-stack.ts actually sets this env var to at deploy
// time; the literal here is only a local-dev/test fallback, same convention
// content-authoring-handler.ts documents for ADMIN_TOKEN_PARAMETER_NAME.
const TURNSTILE_SECRET_PARAMETER_NAME =
  process.env.TURNSTILE_SECRET_PARAMETER_NAME ?? '/ndn/turnstile-secret-key';
const CONTACT_FORM_FROM_EMAIL =
  process.env.CONTACT_FORM_FROM_EMAIL ?? 'noreply@nourishthenerve.com';
const CONTACT_FORM_TO_EMAIL = process.env.CONTACT_FORM_TO_EMAIL ?? 'contact@nourishthenerve.com';

// Mirrors infra/src/config.ts's SES_CONFIGURATION_SET_NAME — that constant
// is what web-stack.ts sets this env var to at deploy time; the literal
// here is only a local-dev/test fallback, same convention this file already
// uses for TURNSTILE_SECRET_PARAMETER_NAME.
const SES_CONFIGURATION_SET_NAME = process.env.SES_CONFIGURATION_SET_NAME ?? 'ndn-email';

const ssmClient = new SSMClient({});

// Resolved once per cold start and reused for the execution environment's
// lifetime — same rationale as content-authoring-handler.ts's
// cachedTokenPromise (a failed read is never cached, so a transient SSM
// blip doesn't wedge a warm container).
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

// One rate limiter per warm Lambda container — resets on cold start, the
// same accepted limitation sms-rate-limiter.ts's InMemoryRateLimiter
// carries until a real persistent store is needed; low-volume contact-form
// traffic doesn't justify one sooner (see 03-cost-model.md's £0.00 line for
// this task).
const rateLimiter: RateLimiter = new InMemoryRateLimiter({
  clock: systemClock,
  limit: CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL,
  windowMs: CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
});

const sendEmail = createSesContactEmailSender({
  fromAddress: CONTACT_FORM_FROM_EMAIL,
  toAddress: CONTACT_FORM_TO_EMAIL,
  configurationSetName: SES_CONFIGURATION_SET_NAME,
});

// verifyTurnstile is built lazily, per call, so a cold start doesn't fail
// before the secret is resolved — createTurnstileVerifier itself never
// touches AWS, only the secret it's given does.
const verifyTurnstile: TurnstileVerifier = async (token) => {
  const secretKey = await getTurnstileSecret();
  return createTurnstileVerifier({ secretKey })(token);
};

export const handler = createContactFormHttpHandler({
  flags,
  verifyTurnstile,
  rateLimiter,
  sendEmail,
});
