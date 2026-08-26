// TASK 4.1.1 step 2: the WebSocket-shaped twin of authorizer.ts's HTTP
// decision. Reuses jwt-verify.ts's TokenVerifier and authorizer.ts's
// directory lookup + role resolution (resolvePrincipal) unchanged — the
// identical two-pool check, wrapped rather than reimplemented. Two things
// differ from the HTTP authorizer:
//
//   1. **Where the token travels.** A browser's `WebSocket` constructor
//      cannot set an `Authorization` header on the handshake, so the token
//      rides as `?token=` on the connect URL instead (infra/src/ws-authorizer.ts's
//      `identitySource`), and this file reads `queryStringParameters.token`
//      rather than a header.
//   2. **The response shape.** `WebSocketLambdaAuthorizer` offers no
//      simple-response option the way `HttpLambdaAuthorizer` does — a
//      WebSocket REQUEST authorizer always returns the classic IAM policy
//      document, keyed to `event.methodArn`, not `{isAuthorized, context}`.
//
// It also reads one thing the HTTP authorizer never does: the
// `video.signalling.enabled` flag. There is no downstream route to 404
// once a socket is open, so "flag off" has to deny the connect itself —
// the same "flag gates the decision, not the deploy" shape every prior
// flag in this codebase uses, applied at the one layer that can still
// apply it for a WebSocket.
import {
  principalContext,
  resolvePrincipal,
  type AuthorizerDecisionLog,
  type AuthorizerDeps,
} from './authorizer.js';
import type { FlagName, FlagReader } from './flags.js';

const VIDEO_SIGNALLING_FLAG: FlagName = 'video.signalling.enabled';
const CONNECT_ROUTE = '$connect';

// API Gateway discards `principalId` once `Effect` is `Deny` — this names
// the outcome rather than inventing an identity for a caller who was never
// verified, the same "never log an unverified sub" discipline
// authorizer.ts's own `deny()` already holds.
const DENY_PRINCIPAL_ID = 'denied';

export interface WebSocketAuthorizerEvent {
  readonly methodArn: string;
  readonly queryStringParameters?: Record<string, string | undefined> | null;
}

export interface WebSocketPolicyStatement {
  readonly Action: 'execute-api:Invoke';
  readonly Effect: 'Allow' | 'Deny';
  readonly Resource: string;
}

export interface WebSocketAuthorizerResult {
  readonly principalId: string;
  readonly policyDocument: {
    readonly Version: '2012-10-17';
    readonly Statement: readonly WebSocketPolicyStatement[];
  };
  readonly context: Record<string, string>;
}

export interface WebSocketAuthorizerDeps extends AuthorizerDeps {
  readonly flags: FlagReader;
}

function policyFor(
  effect: 'Allow' | 'Deny',
  principalId: string,
  methodArn: string,
  context: Record<string, string>,
): WebSocketAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: methodArn }],
    },
    context,
  };
}

/** Exported for ws-authorizer-handler.ts's own catch — an authorizer exception must deny, never surface as a raw 500 to the connecting client. */
export function denyPolicy(methodArn: string): WebSocketAuthorizerResult {
  return policyFor('Deny', DENY_PRINCIPAL_ID, methodArn, {});
}

export function createWebSocketAuthorizer(
  deps: WebSocketAuthorizerDeps,
): (event: WebSocketAuthorizerEvent) => Promise<WebSocketAuthorizerResult> {
  const log = deps.log ?? ((decision) => process.stdout.write(`${JSON.stringify(decision)}\n`));

  return async (event) => {
    const deny = (reason: AuthorizerDecisionLog['reason'], extra: Partial<AuthorizerDecisionLog> = {}) => {
      log({ route: CONNECT_ROUTE, allowed: false, reason, ...extra });
    };

    if (!(await deps.flags.isEnabled(VIDEO_SIGNALLING_FLAG))) {
      deny('flag-disabled');
      return denyPolicy(event.methodArn);
    }

    const token = event.queryStringParameters?.token;
    const resolution = await resolvePrincipal(deps, token, deny);
    if (!resolution) {
      return denyPolicy(event.methodArn);
    }

    const { principal, pool } = resolution;
    log({ route: CONNECT_ROUTE, allowed: true, subjectId: principal.subjectId, pool, role: principal.role });
    return policyFor('Allow', principal.subjectId, event.methodArn, principalContext(principal));
  };
}
