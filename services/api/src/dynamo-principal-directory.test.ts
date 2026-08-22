// TASK 2.2.2 step 4. Same aws-sdk-client-mock shape dynamo-audit-log.test.ts
// uses — the real command objects, so the key and the projection this
// builds are asserted as they would reach DynamoDB.
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DynamoPrincipalDirectory } from './dynamo-principal-directory.js';

const TABLE_NAME = 'ndn-data';
const ddbMock = mockClient(DynamoDBDocumentClient);

function directory() {
  return new DynamoPrincipalDirectory({
    tableName: TABLE_NAME,
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });
}

beforeEach(() => ddbMock.reset());
afterEach(() => ddbMock.reset());

describe('the key shape', () => {
  it('reads a patient profile at PAT#<sub> / PROFILE', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'approved' } });
    await directory().lookup('patient', 'sub-1');

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: 'PAT#sub-1', sk: 'PROFILE' },
    });
  });

  it('reads a clinician profile at CLI#<sub> / PROFILE', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'active' } });
    await directory().lookup('clinician', 'sub-2');

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'CLI#sub-2', sk: 'PROFILE' },
    });
  });

  it('is one GetItem, never a Query or a Scan', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'approved' } });
    await directory().lookup('patient', 'sub-1');

    expect(ddbMock.calls()).toHaveLength(1);
  });
});

describe('what it reads back', () => {
  it('projects the status attribute and nothing else', async () => {
    // The authorizer logs, and a whole patient profile carries `personal{}`
    // and `clinical{}` halves. The projection is what keeps either from
    // ever being in this Lambda's memory (R-09's "a log line").
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'approved' } });
    await directory().lookup('patient', 'sub-1');

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.ProjectionExpression).toBe(
      'account_status',
    );
  });

  it('derives recordId from the subject asked for, not from the item', async () => {
    // A row cannot claim to be a different patient than the one whose key
    // it sits under.
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'approved', id: 'someone-else' } });

    expect(await directory().lookup('patient', 'sub-1')).toEqual({
      recordId: 'sub-1',
      accountStatus: 'approved',
    });
  });

  it.each(['pending', 'approved', 'declined', 'suspended', 'active', 'deactivated'])(
    'passes %s through — the matrix decides what it permits',
    async (accountStatus) => {
      ddbMock.on(GetCommand).resolves({ Item: { account_status: accountStatus } });

      expect((await directory().lookup('patient', 'sub-1'))?.accountStatus).toBe(accountStatus);
    },
  );
});

describe('anything it cannot resolve is a denial', () => {
  it('returns undefined when there is no record — the normal answer until 2.2.3 exists', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await directory().lookup('patient', 'sub-1')).toBeUndefined();
  });

  it('returns undefined for a record with no status attribute', async () => {
    ddbMock.on(GetCommand).resolves({ Item: {} });

    expect(await directory().lookup('patient', 'sub-1')).toBeUndefined();
  });

  it('returns undefined for a status this system does not recognise', async () => {
    // Neither guessing `pending` (inventing a lifecycle state) nor
    // `approved` (granting one) is safe. Deny.
    ddbMock.on(GetCommand).resolves({ Item: { account_status: 'superuser' } });

    expect(await directory().lookup('patient', 'sub-1')).toBeUndefined();
  });

  it('propagates a DynamoDB failure rather than swallowing it into "no record"', async () => {
    // The authorizer distinguishes `lookup-failed` from
    // `no-directory-record` in its log, and both deny. Swallowing here
    // would make an outage indistinguishable from an unknown subject.
    ddbMock.on(GetCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(directory().lookup('patient', 'sub-1')).rejects.toThrow();
  });
});
