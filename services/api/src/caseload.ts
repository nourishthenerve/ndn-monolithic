// TASK 2.5.3: `GET /caseload?cursor=&limit=` — SDK-free and unit-testable,
// the same split every other endpoint uses (caseload-handler.ts wires the
// real DynamoDB-backed GSI3 store and the real Lambda authorizer's
// principal).
//
// Reuses `'patient-profile'`'s own matrix row/column resolution rather
// than a new entity type: a caseload entry *is* a patient profile read,
// many at once, and the row already grants `Principal: R U` while denying
// every other column outright — no new cell needed, unlike TASK 2.5.1's
// "Patient assignment" row, which genuinely had no existing row to reuse.
import type { Principal } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';

import { can } from './authz.js';
import type { CaseloadRepository } from './caseload-repository.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';

const CASELOAD_FLAG = 'caseload.view.enabled';
const CASELOAD_RESOURCE = { entityType: 'patient-profile' } as const;

/** DynamoDB's own Query `Limit`, bounded — step 5's "never accumulate a caseload in memory" starts with never asking for an unbounded page. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface CaseloadDeps {
  readonly repository: CaseloadRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

function parsePageSize(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

export function createCaseloadHandler(
  deps: CaseloadDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  // Every request, unsampled — the lowest-volume admin surface in the
  // estate (one principal, browsing occasionally), same reasoning
  // audit-read.ts states for its own sample rate.
  const logger = deps.logger ?? createSampledLogger({ clock, sampleRate: 1 });

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

    if (!(await deps.flags.isEnabled(CASELOAD_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    // Checked before the query string is even parsed — a caller the
    // matrix denies must not be able to tell a well-formed request from a
    // malformed one by the shape of the refusal (audit-read.ts's own rule).
    // No clinician-id parameter exists for a sub-clinician to try passing
    // in the first place: this route has none to scope by, only
    // `cursor`/`limit` — "cannot reach another clinician's caseload by any
    // parameter" holds because there is no parameter that names one.
    if (!can(principal, 'read', CASELOAD_RESOURCE).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }

    try {
      const cursor = event.queryStringParameters?.cursor;
      const limit = parsePageSize(event.queryStringParameters?.limit);
      const page = await deps.repository.listPage(principal, cursor, limit);
      // `counts` is present on the first page only (caseload-repository.ts)
      // — omitted rather than sent as null, so a caller can tell "not
      // counted on this page" from "counted, and the answer is zero".
      return respond(200, {
        items: page.items,
        nextCursor: page.nextCursor,
        ...(page.counts ? { counts: page.counts } : {}),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_CURSOR') {
        return respond(400, { error: error.code });
      }
      throw error;
    }
  };
}
