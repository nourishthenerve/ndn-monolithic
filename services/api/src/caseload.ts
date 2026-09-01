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

    // **`assignedClinicianId` is the caller's own id, always.** 2026-09-01:
    // the owner, on finding a treating clinician had no dashboard at all —
    // *"clinican doesn't have view to the patient dashboard"*, against the
    // original spec's *"clinician … will have access to the dashboard but
    // will only be able to see those patients that have been assigned to
    // him."*
    //
    // Before this, the resource named no clinician, so a sub-clinician
    // resolved to the `'Sub-clinician (unassigned)'` column and was refused
    // outright. Naming their own id is the same "self-assigned resource"
    // trick `GET /clinicians/me/calendar` already uses: a sub-clinician
    // lands on `'Sub-clinician (assigned)'` and is granted, a principal
    // lands on `'Principal'` regardless, helpdesk and visitor resolve by
    // role, and a patient still lands on `'Patient (other)'` and is denied.
    //
    // It widens *who may call*, never *what comes back*: which patients a
    // sub-clinician actually sees is `caseload-repository.ts`'s own filter,
    // the same layer the visitor's `IIC` narrowing lives in and for the
    // same reason — the matrix has no vocabulary for "rows where a field
    // equals a value".
    //
    // "Cannot reach another clinician's caseload by any parameter" holds
    // exactly as before, and now matters more: the id comes from the
    // verified principal, and this route still has no parameter that names
    // a clinician — only `cursor`/`limit`.
    //
    // Checked before the query string is even parsed — a caller the matrix
    // denies must not be able to tell a well-formed request from a
    // malformed one by the shape of the refusal (audit-read.ts's own rule).
    const caseloadResource = {
      entityType: 'patient-profile',
      assignedClinicianId: principal.clinicianId,
    } as const;
    if (!can(principal, 'read', caseloadResource).allowed) {
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
