#!/usr/bin/env node
// 2026-08-31: a one-off, idempotent backfill for the two directory
// projections added the same day.
//
// ## Why this exists
//
// Two index projections changed shape, and DynamoDB does not rewrite
// existing rows when the application starts deriving a new one:
//
//   * **`CLI#<id>` / `PROFILE`** gained `gsi2pk = 'CLINICIAN_INDEX#all'` /
//     `gsi2sk = 'CLI#<id>'`, which is what `GET /clinicians` queries. Any
//     clinician created before this date — including the principal, the
//     one account that certainly exists — is absent from that index and so
//     invisible to the directory, the dashboard's "reassign to…" dropdown,
//     and the deactivate control.
//   * **`PAT#<id>` / `PROFILE`** gained a GSI3 projection on *every*
//     patient (it was previously sparse on `assigned_clinician_id`) and a
//     `<rank>#` prefix on `gsi3sk`. Rows written before this date either
//     have no GSI3 attributes at all (never assigned) or carry the old,
//     unranked sort key — either way they sort or filter wrongly on the
//     patient dashboard.
//
// ## Why a Scan is acceptable here and nowhere else
//
// This codebase's standing rule is that no request path ever reaches the
// table with a `Scan` (docs/adr/0002-database.md; every repository is
// built around a Query). That rule is about *serving traffic* — an
// unbounded read on a hot path. This is a one-shot maintenance job, run by
// a human, against a table whose whole point is that it is small; there is
// no index that answers "every row that predates the index" by
// construction, because such a row is precisely the one no index knows
// about.
//
// ## Running it
//
//   AWS_PROFILE=ndn-prod AWS_REGION=<region> \
//     node scripts/backfill-directory-index.mjs --table <table-name>
//
// Dry run by default: it prints what it would change and writes nothing.
// Add `--apply` to write. Safe to run repeatedly — a row already carrying
// the correct projection is skipped, so a second run reports zero changes.
//
// It only ever *adds or corrects the index attributes* on rows that
// already exist (an `UpdateItem` naming exactly those attributes), never a
// `PutItem` that could clobber a concurrent write to a domain field, and
// never a delete of anything.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const CLINICIAN_INDEX_GSI2PK = 'CLINICIAN_INDEX#all';
const GSI3_CASELOAD_PK = 'CASELOAD#all';
const GSI3_UNASSIGNED_CLINICIAN = 'UNASSIGNED';

// Must stay identical to `PATIENT_DIRECTORY_RANK` in
// services/api/src/dynamo-store.ts. Duplicated rather than imported: this
// script is plain Node against the deployed table and does not build the
// TypeScript service to run.
const PATIENT_DIRECTORY_RANK = {
  approved: '0',
  pending: '1',
  suspended: '2',
  declined: '3',
};

function parseArgs(argv) {
  const args = { apply: false, table: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--table') {
      i += 1;
      args.table = argv[i];
    }
  }
  return args;
}

function clinicianProjection(item) {
  return { gsi2pk: CLINICIAN_INDEX_GSI2PK, gsi2sk: `CLI#${item.id}` };
}

function patientProjection(item) {
  const rank = PATIENT_DIRECTORY_RANK[item.account_status];
  if (!rank) {
    return undefined;
  }
  const clinicianId = item.assigned_clinician_id ?? GSI3_UNASSIGNED_CLINICIAN;
  return {
    gsi3pk: GSI3_CASELOAD_PK,
    gsi3sk: `${rank}#CLI#${clinicianId}#PAT#${item.id}`,
  };
}

/** True when the row already carries exactly `projection` — the idempotency check. */
function upToDate(item, projection) {
  return Object.entries(projection).every(([key, value]) => item[key] === value);
}

async function main() {
  const { apply, table } = parseArgs(process.argv.slice(2));
  if (!table) {
    console.error('usage: node scripts/backfill-directory-index.mjs --table <table-name> [--apply]');
    process.exitCode = 1;
    return;
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const summary = { clinicians: 0, patients: 0, skipped: 0, unknownStatus: 0 };
  let startKey;

  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        // The two `PROFILE` rows only. Everything else in this
        // single-table design — audit rows, assignment history, content,
        // appointments — is left entirely alone.
        FilterExpression: 'sk = :profile AND (begins_with(pk, :cli) OR begins_with(pk, :pat))',
        ExpressionAttributeValues: { ':profile': 'PROFILE', ':cli': 'CLI#', ':pat': 'PAT#' },
        ExclusiveStartKey: startKey,
      }),
    );

    for (const item of page.Items ?? []) {
      const isClinician = String(item.pk).startsWith('CLI#');
      const projection = isClinician ? clinicianProjection(item) : patientProjection(item);
      if (!projection) {
        console.warn(`skip ${item.pk}: unrecognised account_status ${String(item.account_status)}`);
        summary.unknownStatus += 1;
        continue;
      }
      if (upToDate(item, projection)) {
        summary.skipped += 1;
        continue;
      }

      const entries = Object.entries(projection);
      console.log(
        `${apply ? 'update' : 'would update'} ${item.pk} -> ${entries
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')}`,
      );
      if (apply) {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
            ExpressionAttributeNames: Object.fromEntries(
              entries.map(([key], i) => [`#k${i}`, key]),
            ),
            ExpressionAttributeValues: Object.fromEntries(
              entries.map(([, value], i) => [`:v${i}`, value]),
            ),
            // The row must still exist — this never creates one.
            ConditionExpression: 'attribute_exists(pk)',
          }),
        );
      }
      if (isClinician) summary.clinicians += 1;
      else summary.patients += 1;
    }

    startKey = page.LastEvaluatedKey;
  } while (startKey);

  console.log(
    `${apply ? 'updated' : 'would update'}: ${summary.clinicians} clinician(s), ${summary.patients} patient(s); ${summary.skipped} already correct; ${summary.unknownStatus} skipped for an unrecognised status`,
  );
  if (!apply) {
    console.log('dry run — re-run with --apply to write.');
  }
}

await main();
