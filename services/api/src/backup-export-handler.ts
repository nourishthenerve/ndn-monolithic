// D-22: the deployed Lambda entry for the daily backup export
// (infra/src/backup-export.ts, EventBridge `rate(1 day)`), invoked on a
// schedule rather than `HttpApi` — a `ScheduledHandler`, not an API
// Gateway one, matching reminder-sweep-handler.ts's own split.
import { ExportTableToPointInTimeCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { ScheduledHandler } from 'aws-lambda';

import { runBackupExport } from './backup-export.js';

const client = new DynamoDBClient({});
const tableArn = process.env.TABLE_ARN ?? '';
const bucketName = process.env.BACKUP_BUCKET_NAME ?? '';

export const handler: ScheduledHandler = async () => {
  await runBackupExport(
    {
      startExport: async (input) => {
        const result = await client.send(
          new ExportTableToPointInTimeCommand({
            TableArn: input.tableArn,
            S3Bucket: input.s3Bucket,
            S3Prefix: input.s3Prefix,
            ExportFormat: 'DYNAMODB_JSON',
          }),
        );
        return { exportArn: result.ExportDescription?.ExportArn };
      },
    },
    tableArn,
    bucketName,
  );
};
