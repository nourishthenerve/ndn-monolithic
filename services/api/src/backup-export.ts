// D-22's periodic-export half (`infra/src/backup-export.ts`'s own header
// carries the full reasoning — GOVERNANCE-mode Object Lock, once a day).
// SDK-free: `startExport` is injected, the same "business logic in one
// file, wiring in another" split `reminder-sweep.ts`/`reminder-sweep-handler.ts`
// already use, here for testability without a real DynamoDB export call
// (which cannot be run against anything but a real table with real PITR
// enabled — no local/emulated equivalent exists).
import { systemClock, type Clock } from './clock.js';

export interface StartExportInput {
  readonly tableArn: string;
  readonly s3Bucket: string;
  readonly s3Prefix: string;
}

export interface StartExportResult {
  readonly exportArn?: string;
}

export interface BackupExportDeps {
  readonly startExport: (input: StartExportInput) => Promise<StartExportResult>;
  readonly clock?: Clock;
  /** Injectable for tests; defaults to one structured stdout line, matching every other scheduled function in this codebase. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** `exports/<YYYY-MM-DD>/` — one prefix per calendar day, so a day that fires twice (a retried/duplicate schedule tick) overwrites rather than accumulating an unbounded number of near-identical exports. */
export function exportPrefix(now: Date): string {
  return `exports/${now.toISOString().slice(0, 10)}/`;
}

export async function runBackupExport(
  deps: BackupExportDeps,
  tableArn: string,
  bucketName: string,
): Promise<void> {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
  const now = clock.now();
  const s3Prefix = exportPrefix(now);

  const result = await deps.startExport({ tableArn, s3Bucket: bucketName, s3Prefix });

  log({
    level: 'info',
    event: 'backup-export-started',
    exportArn: result.exportArn,
    s3Prefix,
    timestamp: now.toISOString(),
  });
}
