// TASK 2.2.2: the only place in this repository that parses a JWT. No
// handler reads the `Authorization` header, ever — request-principal.ts
// exists so a handler cannot even be tempted.
//
// **Two verifiers, tried in turn, rather than one multi-pool verifier.**
// The plan's hardest requirement is that a caller's *role* comes from the
// issuer and never from a claim the caller could influence. A multi-pool
// verifier satisfies that too — `iss` is trustworthy once the signature is
// checked — but it makes the guarantee something you have to reason about
// afterwards. Here, the pool is not read from the token at all: it is
// whichever verifier's key set validated the signature. A token minted by
// the patient pool cannot come back as a clinician because the clinician
// verifier will not verify it, full stop.
//
// The cost is one extra verification attempt for clinician tokens. Both
// attempts are cache hits after the first JWKS fetch (aws-jwt-verify caches
// per verifier), and API Gateway caches the *authorizer decision* for five
// minutes on top of that, so this is not on a hot path.
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Which directory minted the token — not the application role. Mapping
 * this onto `Role` (patient / sub-clinician / principal-clinician) is
 * authorizer-handler.ts's job, because the clinician split needs the
 * group claim as well.
 */
export type TokenPool = 'patient' | 'clinician';

export interface VerifiedToken {
  readonly pool: TokenPool;
  /** The Cognito `sub`. The only identifier this layer produces. */
  readonly subjectId: string;
  /** `cognito:groups`, empty when the claim is absent. Only an admin action can set it. */
  readonly groups: readonly string[];
}

export interface TokenVerifier {
  /** Resolves `undefined` for *every* failure — expired, wrong key, wrong pool, unreachable JWKS. Never throws. */
  verify(token: string): Promise<VerifiedToken | undefined>;
}

export interface CognitoVerifierConfig {
  readonly patientUserPoolId: string;
  readonly patientClientId: string;
  readonly clinicianUserPoolId: string;
  readonly clinicianClientId: string;
}

const BEARER_PREFIX = 'Bearer ';

/**
 * `undefined` for anything that is not exactly one `Bearer <non-empty>`.
 *
 * Deliberately its own copy rather than a shared import: until TASK 2.5.4,
 * this same five-line function also lived in admin-auth.ts, the
 * shared-secret bearer gate — the one piece of code every authenticated
 * request passes through was kept free of a dependency on something
 * scheduled for deletion, rather than sharing an implementation that would
 * have needed splitting apart again once that file was deleted. 2.5.4 did
 * delete it; this copy needed no change.
 */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : undefined;
}

/**
 * `token_use` is pinned to `access` and only `access`.
 *
 * The ID token is a statement *to the client* about who signed in; the
 * access token is the credential presented *to an API*. They are signed by
 * the same keys and both carry `sub` and `cognito:groups`, so accepting
 * either would work — and would mean a token the browser holds for its own
 * rendering is also a credential against every route. One value, pinned,
 * asserted in its own negative test.
 */
const TOKEN_USE = 'access' as const;

interface PoolVerifier {
  readonly pool: TokenPool;
  verify(token: string): Promise<{ sub: string; 'cognito:groups'?: string[] }>;
}

function groupsFrom(payload: { 'cognito:groups'?: unknown }): readonly string[] {
  const groups = payload['cognito:groups'];
  return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === 'string') : [];
}

/**
 * Builds the real verifier pair. `clientId` is checked by aws-jwt-verify
 * itself (against `client_id` on an access token), so a token minted for
 * some other app client on the same pool — one a future task adds, say —
 * is rejected here rather than trusted because the issuer matched.
 */
export function createCognitoTokenVerifier(config: CognitoVerifierConfig): TokenVerifier {
  const verifiers: PoolVerifier[] = [
    {
      pool: 'patient',
      verify: (token) =>
        CognitoJwtVerifier.create({
          userPoolId: config.patientUserPoolId,
          clientId: config.patientClientId,
          tokenUse: TOKEN_USE,
        }).verify(token),
    },
    {
      pool: 'clinician',
      verify: (token) =>
        CognitoJwtVerifier.create({
          userPoolId: config.clinicianUserPoolId,
          clientId: config.clinicianClientId,
          tokenUse: TOKEN_USE,
        }).verify(token),
    },
  ];
  return verifierOver(verifiers);
}

/** Exported for tests: the same try-each logic over injected verifiers. */
export function verifierOver(verifiers: readonly PoolVerifier[]): TokenVerifier {
  return {
    async verify(token) {
      for (const verifier of verifiers) {
        try {
          const payload = await verifier.verify(token);
          // A verified token with no `sub` is not a token this system can
          // identify anyone by. Deny rather than invent an identity.
          if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
            return undefined;
          }
          return { pool: verifier.pool, subjectId: payload.sub, groups: groupsFrom(payload) };
        } catch {
          // Every failure looks the same from here on purpose: an expired
          // token, a token signed with the wrong key, `alg: none`, an
          // RS256 token re-signed as HS256, the other pool's issuer, a
          // wrong `aud`, and a JWKS endpoint that would not answer are all
          // "not verified". Distinguishing them would put a decision on
          // the error path, and the error path must have exactly one
          // outcome.
          continue;
        }
      }
      return undefined;
    },
  };
}

/**
 * Caches the verifier pair across warm invocations. Constructing them per
 * request would throw away aws-jwt-verify's JWKS cache and put an HTTPS
 * round trip in front of every authorisation decision.
 */
export function memoiseVerifier(build: () => TokenVerifier): () => TokenVerifier {
  let cached: TokenVerifier | undefined;
  return () => (cached ??= build());
}
