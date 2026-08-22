// TASK 2.2.3: the HTTP boundary for `POST /registrations`
// (infra/src/data-stack.ts). Same split as contact-form-handler.ts —
// `createRegistrationHttpHandler` holds the flag gate, Zod validation, IP
// hashing and response shaping and is unit-testable with injected deps;
// everything below its export is the once-per-cold-start AWS wiring.
import { createHash } from 'node:crypto';

import { CognitoIdentityProviderClient, SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { systemClock, type Clock } from './clock.js';
import { DynamoIntakeStore } from './dynamo-intake-store.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import {
  createRegistration,
  registrationRequestSchema,
  REGISTRATION_RATE_LIMIT,
  REGISTRATION_RATE_WINDOW_MS,
  type IntakeStore,
  type SignUpPort,
} from './registration.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.js';

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Never the raw address — same one-way hash contact-form-handler.ts uses, for the same reason. */
function hashSourceIp(sourceIp: string): string {
  return createHash('sha256').update(sourceIp).digest('hex');
}

// Every request, unsampled. Registration is low volume and it is the one
// route where "how many attempts came from where" is a question worth
// being able to answer afterwards.
const REGISTRATION_LOG_SAMPLE_RATE = 1;

export interface RegistrationHttpDeps {
  readonly flags: FlagReader;
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly signUp: SignUpPort;
  readonly intake: IntakeStore;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createRegistrationHttpHandler(
  deps: RegistrationHttpDeps,
): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: REGISTRATION_LOG_SAMPLE_RATE });
  const register = createRegistration({
    flags: deps.flags,
    verifyTurnstile: deps.verifyTurnstile,
    rateLimiter: deps.rateLimiter,
    signUp: deps.signUp,
    intake: deps.intake,
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

    // Zod before Turnstile, before any outbound call — a malformed body is
    // a 400 on its own, not a wasted siteverify round trip.
    const parsed = registrationRequestSchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      // The flag is checked *after* parsing but its answer wins: an
      // invalid body against a disabled route still gets 404, because the
      // route does not exist. Handled by ordering the switch below rather
      // than by checking twice.
      if (!(await deps.flags.isEnabled('auth.patientRegistration.enabled'))) {
        return respond(404, { error: 'NOT_FOUND' });
      }
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const result = await register(
      parsed.data,
      hashSourceIp(event.requestContext.http.sourceIp),
    );

    switch (result.kind) {
      case 'disabled':
        return respond(404, { error: 'NOT_FOUND' });
      case 'blocked':
        return respond(result.reason === 'rateLimited' ? 429 : 400, {
          error: result.reason === 'rateLimited' ? 'RATE_LIMITED' : 'TURNSTILE_FAILED',
        });
      case 'accepted':
        // 202, not 201: nothing of the patient's exists yet. A Cognito
        // account is unconfirmed and there is no `PAT#` record until they
        // read the mailbox. "Accepted" is the honest status code.
        return respond(202, { status: 'accepted' });
    }
  };
}

// --- AWS wiring below. ---

const TURNSTILE_SECRET_PARAMETER_NAME =
  process.env.TURNSTILE_SECRET_PARAMETER_NAME ?? '/ndn/turnstile-secret-key';

const ssmClient = new SSMClient({});
let cachedSecretPromise: Promise<string> | undefined;

function getTurnstileSecret(): Promise<string> {
  cachedSecretPromise ??= ssmClient
    .send(
      new GetParameterCommand({ Name: TURNSTILE_SECRET_PARAMETER_NAME, WithDecryption: true }),
    )
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${TURNSTILE_SECRET_PARAMETER_NAME} has no value`);
      }
      return value;
    })
    .catch((error: unknown) => {
      // A failed read is never cached, so a transient SSM blip does not
      // wedge a warm container — same rule contact-form-handler.ts states.
      cachedSecretPromise = undefined;
      throw error;
    });
  return cachedSecretPromise;
}

const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * `SignUp` with **no password**. TASK 2.2.1's patient pool has email OTP
 * as a first factor, and AWS's own API reference is explicit: "Users can
 * sign up without a password when your user pool supports passwordless
 * sign-in… To create a user with no password, omit this parameter."
 * Omitting it is what makes "no password" true of the account itself and
 * not only of the sign-in path.
 *
 * No `SecretHash` either — the client is public (`generateSecret: false`),
 * so there is no secret to hash with. And no IAM permission: `SignUp` is
 * an unauthenticated Cognito operation, which is why this function's role
 * carries no `cognito-idp` grant at all.
 */
const signUpPort: SignUpPort = {
  async signUp(email) {
    try {
      const response = await cognitoClient.send(
        new SignUpCommand({
          ClientId: process.env.PATIENT_USER_POOL_CLIENT_ID ?? '',
          Username: email,
          UserAttributes: [{ Name: 'email', Value: email }],
        }),
      );
      return { outcome: 'created', subjectId: response.UserSub ?? '' };
    } catch (error) {
      if ((error as { name?: string }).name === 'UsernameExistsException') {
        return { outcome: 'exists' };
      }
      throw error;
    }
  },
};

export const handler = createRegistrationHttpHandler({
  flags: createSsmFlagReader(),
  // Built lazily per call so a cold start does not fail before the secret
  // resolves — the same shape contact-form-handler.ts uses.
  verifyTurnstile: async (token) => createTurnstileVerifier({ secretKey: await getTurnstileSecret() })(token),
  // In-memory, per execution environment — the same limiter the contact
  // form uses, and the same caveat: it bounds one container's traffic, not
  // the account's. Cognito's own per-address throttling is the backstop.
  rateLimiter: new InMemoryRateLimiter({
    clock: systemClock,
    limit: REGISTRATION_RATE_LIMIT,
    windowMs: REGISTRATION_RATE_WINDOW_MS,
  }),
  signUp: signUpPort,
  intake: new DynamoIntakeStore({ tableName: process.env.PRINCIPAL_TABLE_NAME ?? '' }),
});
