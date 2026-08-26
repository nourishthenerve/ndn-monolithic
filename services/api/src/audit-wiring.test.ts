// TASK 2.1.3's last named negative: "`InMemoryAuditLog` is no longer
// imported by any production handler (a lint-level assertion, the same
// shape as Gate G1 §3a's fix)."
//
// Why this is a test and not a review habit: `InMemoryFlagSource` was
// wired into nine production handlers for five milestones because every
// task after 1.3.1 re-noted the deferral instead of closing it, and
// nothing failed while it was true (`gate-g1-report.md` §3a). The audit
// writer had exactly the same shape of deferral — "no DynamoDB table
// exists yet", written when that was true and left standing for six
// months after it stopped being. A source-level assertion is what makes
// the next such regression a red build on the commit that introduces it.
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const SOURCE_DIR = new URL('.', import.meta.url);

function productionSources(): { name: string; source: string }[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({
      name,
      source: readFileSync(new URL(name, SOURCE_DIR), 'utf8'),
    }));
}

describe('audit wiring', () => {
  it('no production file imports InMemoryAuditLog — audit.ts is the only place the name appears', () => {
    const importers = productionSources()
      .filter(({ name }) => name !== 'audit.ts')
      .filter(({ source }) => source.includes('InMemoryAuditLog'))
      .map(({ name }) => name);

    expect(importers).toEqual([]);
  });

  // TASK 4.1.1: connection-repository.ts is deliberately the one
  // repository in this codebase with no `AuditWriter` dependency at all —
  // its own header states why (operational metadata, not an `AuditAction`
  // the audit log needs to know about, the same distinction TASK 2.1.3's
  // own header draws between what gets audited and what does not). A
  // handler wiring it can never "hand it the durable writer" because
  // there is no writer parameter to hand — exempting the call sites by
  // name, not by weakening the check, keeps this test able to catch the
  // next entity that silently drops audit wiring by omission rather than
  // by this one, recorded decision. TASK 4.2.2's ws-relay-handler.ts is
  // the third: the relay's own decision (ws-relay.ts) never writes an
  // audit event — 4.2.1's join decision is the one place a call-related
  // access decision is recorded, and relaying an already-authorised
  // message is not a second one.
  const CONNECTION_REPOSITORY_HANDLERS = [
    'ws-connect-handler.ts',
    'ws-disconnect-handler.ts',
    'ws-relay-handler.ts',
  ];

  it('every handler that constructs a repository hands it the durable writer', () => {
    const offenders = productionSources()
      .filter(({ name }) => name.endsWith('-handler.ts'))
      .filter(({ name }) => !CONNECTION_REPOSITORY_HANDLERS.includes(name))
      .filter(({ source }) => /new \w*Repository\(/.test(source))
      .filter(({ source }) => !source.includes('new DynamoAuditLog('))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it('finds the handlers it is meant to be checking (the filter above is not vacuous)', () => {
    const checked = productionSources()
      .filter(({ name }) => name.endsWith('-handler.ts'))
      .filter(({ name }) => !CONNECTION_REPOSITORY_HANDLERS.includes(name))
      .filter(({ source }) => /new \w*Repository\(/.test(source))
      .map(({ name }) => name);

    expect(checked.length).toBeGreaterThanOrEqual(8);
  });

  it('no production file writes an audit row without going through auditEventFor', () => {
    const offenders = productionSources()
      .filter(({ name }) => name !== 'audit.ts' && name !== 'dynamo-audit-log.ts')
      .filter(({ source }) => /\.audit\.write\(/.test(source))
      .filter(({ source }) => !source.includes('auditEventFor('))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});
