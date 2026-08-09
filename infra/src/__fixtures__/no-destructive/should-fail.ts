// Fixture proving ndn/no-destructive-primitives blocks every banned category.
// Run: pnpm lint:no-destructive  (expected: non-zero exit, one error per line below)
// Excluded from the normal `pnpm -r lint` run — see eslint.config.js ignores.
// See docs/plan/05-execution-plan.md TASK 0.3.1 and docs/plan/00-conventions.md.

export const DeleteObjectCommand = class {};
export const DeleteObjectsCommand = class {};
export const DeleteItemCommand = class {};

new DeleteObjectCommand();
new DeleteObjectsCommand();
new DeleteItemCommand();

export const batchWriteDeleteRequest = {
  DeleteRequest: { Key: { id: '123' } },
};

export function rawSqlDelete(id: string): string {
  return `DELETE FROM patients WHERE id = ${id}`;
}

export const rawSqlTruncate = 'TRUNCATE TABLE patients';
export const rawSqlDrop = 'DROP TABLE patients';

// s3:DeleteObject* outside a Deny-effect statement — still banned even though
// this file is under infra/, because the allowlist requires *both* infra/ and
// effect: Deny (see should-pass.ts for the allowed shape).
export const s3AllowDeleteObject = {
  effect: 'Allow',
  actions: ['s3:DeleteObject'],
  resources: ['arn:aws:s3:::example-bucket/*'],
};
