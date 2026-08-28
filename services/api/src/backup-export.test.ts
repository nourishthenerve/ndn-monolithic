import { describe, expect, it, vi } from 'vitest';

import { exportPrefix, runBackupExport } from './backup-export.js';

describe('exportPrefix', () => {
  it('is one prefix per calendar day', () => {
    expect(exportPrefix(new Date('2026-08-28T14:32:07.123Z'))).toBe('exports/2026-08-28/');
  });

  it('is stable for two different times on the same day', () => {
    const morning = exportPrefix(new Date('2026-08-28T00:00:00.000Z'));
    const night = exportPrefix(new Date('2026-08-28T23:59:59.999Z'));
    expect(morning).toBe(night);
  });

  it('differs across a day boundary', () => {
    const day1 = exportPrefix(new Date('2026-08-28T23:59:59.999Z'));
    const day2 = exportPrefix(new Date('2026-08-29T00:00:00.000Z'));
    expect(day1).not.toBe(day2);
  });
});

describe('runBackupExport', () => {
  it('starts an export with the derived prefix and logs its exportArn', async () => {
    const startExport = vi.fn().mockResolvedValue({ exportArn: 'arn:aws:dynamodb:export/1' });
    const log = vi.fn();
    const clock = { now: () => new Date('2026-08-28T03:00:00.000Z') };

    await runBackupExport({ startExport, log, clock }, 'arn:aws:dynamodb:table/ndn', 'my-bucket');

    expect(startExport).toHaveBeenCalledWith({
      tableArn: 'arn:aws:dynamodb:table/ndn',
      s3Bucket: 'my-bucket',
      s3Prefix: 'exports/2026-08-28/',
    });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'backup-export-started',
        exportArn: 'arn:aws:dynamodb:export/1',
        s3Prefix: 'exports/2026-08-28/',
      }),
    );
  });

  it('propagates a failed export rather than swallowing it', async () => {
    const startExport = vi.fn().mockRejectedValue(new Error('ExportConflictException'));

    await expect(
      runBackupExport(
        { startExport, clock: { now: () => new Date('2026-08-28T00:00:00.000Z') } },
        'arn:aws:dynamodb:table/ndn',
        'my-bucket',
      ),
    ).rejects.toThrow('ExportConflictException');
  });
});
