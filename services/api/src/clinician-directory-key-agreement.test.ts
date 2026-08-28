// Found live, 2026-08-28, the first real clinician sign-in ever attempted:
// DynamoClinicianStore (dynamo-store.ts) wrote a clinician's row at
// `SK = META`; DynamoPrincipalDirectory (dynamo-principal-directory.ts) —
// what the authorizer actually reads — looked it up at `SK = PROFILE`.
// Both sides were individually well-tested and both passed, because a unit
// test that mocks the DynamoDB response can't catch two modules disagreeing
// about a key neither test ever asks the other about. The practical
// effect: every clinician account ever created, real or test, was
// authorization-dead (`no-directory-record` on every request) from
// TASK 2.4.1 onward, undiscovered until TASK 5.3.1's own prerequisite work
// tried a real sign-in.
//
// This test exists to make that specific failure mode structurally
// impossible to reintroduce silently: it writes a clinician through the
// real `DynamoClinicianStore.create()` into a genuine in-memory fake table
// (not a mocked response), then reads it back through the real
// `DynamoPrincipalDirectory.lookup()` against that same table. If the two
// ever disagree on a key again, this fails with "no record found," not a
// green suite on both sides.
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Clinician } from '@ndn/shared-types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { DynamoPrincipalDirectory } from './dynamo-principal-directory.js';
import { DynamoClinicianStore } from './dynamo-store.js';

const TABLE_NAME = 'ndn-data';
const ddbMock = mockClient(DynamoDBDocumentClient);

/** A real key-value table, not a canned response — the point of this test. */
function fakeTable(): Map<string, Record<string, unknown>> {
  const table = new Map<string, Record<string, unknown>>();
  const keyOf = (pk: unknown, sk: unknown): string => `${String(pk)}#${String(sk)}`;

  ddbMock.on(PutCommand).callsFake((input) => {
    table.set(keyOf(input.Item?.pk, input.Item?.sk), input.Item as Record<string, unknown>);
    return {};
  });
  ddbMock.on(TransactWriteCommand).callsFake((input) => {
    for (const transactItem of input.TransactItems ?? []) {
      const item = transactItem.Put?.Item;
      if (item) table.set(keyOf(item.pk, item.sk), item as Record<string, unknown>);
    }
    return {};
  });
  ddbMock.on(GetCommand).callsFake((input) => {
    const item = table.get(keyOf(input.Key?.pk, input.Key?.sk));
    return item ? { Item: item } : {};
  });

  return table;
}

beforeEach(() => ddbMock.reset());

describe('DynamoClinicianStore and DynamoPrincipalDirectory agree on the clinician key', () => {
  it('a clinician written by the store is found by the directory the authorizer uses', async () => {
    fakeTable();
    const store = new DynamoClinicianStore({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });
    const directory = new DynamoPrincipalDirectory({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });

    const clinician: Clinician = {
      id: 'sub-1',
      displayName: 'Dr Test',
      role: 'sub',
      account_status: 'active',
      status: 'active',
      created_at: '2026-08-28T00:00:00.000Z',
      updated_at: '2026-08-28T00:00:00.000Z',
    };
    await store.create(clinician);

    const entry = await directory.lookup('clinician', 'sub-1');

    expect(entry).toEqual({ recordId: 'sub-1', accountStatus: 'active' });
  });

  it('a principal written by the store is found by the directory too, alongside its marker row', async () => {
    fakeTable();
    const store = new DynamoClinicianStore({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });
    const directory = new DynamoPrincipalDirectory({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });

    await store.create({
      id: 'sub-principal',
      displayName: 'Dr Principal',
      role: 'principal',
      account_status: 'active',
      status: 'active',
      created_at: '2026-08-28T00:00:00.000Z',
      updated_at: '2026-08-28T00:00:00.000Z',
    });

    const entry = await directory.lookup('clinician', 'sub-principal');

    expect(entry).toEqual({ recordId: 'sub-principal', accountStatus: 'active' });
  });
});
