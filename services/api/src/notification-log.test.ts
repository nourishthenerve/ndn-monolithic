import { describe, expect, it } from 'vitest';

import { InMemoryDeliveryLog, type DeliveryRecord } from './notification-log.js';

const RECORD: DeliveryRecord = {
  at: '2026-08-22T09:00:00.000Z',
  recipientId: 'patient-1',
  template: 'appointmentReminder1Hour',
  channel: 'sms',
  outcome: 'sent',
};

describe('InMemoryDeliveryLog', () => {
  it('appends records and lists them back in order', async () => {
    const log = new InMemoryDeliveryLog();
    await log.append(RECORD);
    await log.append({ ...RECORD, channel: 'email', outcome: 'degraded', reason: 'Capped' });

    expect(log.list()).toEqual([RECORD, { ...RECORD, channel: 'email', outcome: 'degraded', reason: 'Capped' }]);
  });

  it('returns a snapshot — mutating the returned array does not affect the log', async () => {
    const log = new InMemoryDeliveryLog();
    await log.append(RECORD);

    const snapshot = log.list() as DeliveryRecord[];
    snapshot.push({ ...RECORD, recipientId: 'intruder' });

    expect(log.list()).toEqual([RECORD]);
  });
});
