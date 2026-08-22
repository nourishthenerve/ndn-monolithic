import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-destructive-primitives.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// RuleTester's assertions run inside `run()`, not per-case — wrapping in a
// single vitest `it` gives one clear pass/fail node per file in reporters,
// consistent with how the rest of this repo's trivial harness tests read.
describe('ndn/no-destructive-primitives', () => {
  it('accepts non-destructive code and infra/ deny-effect S3 policies', () => {
    ruleTester.run('no-destructive-primitives', rule, {
      valid: [
        'const x = 1;',
        'new GetObjectCommand({ Bucket, Key });',
        "const label = 'Delete this workshop registration';",
        "const hint = 'Drag and drop to reorder';",
        "const action = 's3:DeleteBucket';", // not the DeleteObject* family
        'new AdminDisableUserCommand({ UserPoolId, Username });',
        'new AdminEnableUserCommand({ UserPoolId, Username });',
        {
          code: `
            const denyS3Delete = {
              effect: 'Deny',
              actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
              resources: ['arn:aws:s3:::example/*'],
            };
          `,
          filename: 'infra/src/stack.js',
        },
        {
          code: `
            const denyS3Delete = {
              effect: iam.Effect.DENY,
              actions: ['s3:DeleteObject'],
            };
          `,
          filename: 'infra/src/stack.js',
        },
      ],
      invalid: [
        {
          code: 'new DeleteObjectCommand({ Bucket, Key });',
          errors: [{ messageId: 'bannedIdentifier', data: { name: 'DeleteObjectCommand' } }],
        },
        {
          code: 'new DeleteObjectsCommand({ Bucket, Delete: { Objects: [] } });',
          errors: [{ messageId: 'bannedIdentifier', data: { name: 'DeleteObjectsCommand' } }],
        },
        {
          code: 'new DeleteItemCommand({ TableName, Key });',
          errors: [{ messageId: 'bannedIdentifier', data: { name: 'DeleteItemCommand' } }],
        },
        {
          code: 'const req = { DeleteRequest: { Key: { id } } };',
          errors: [{ messageId: 'bannedIdentifier', data: { name: 'DeleteRequest' } }],
        },
        {
          code: 'new AdminDeleteUserCommand({ UserPoolId, Username });',
          errors: [{ messageId: 'bannedIdentifier', data: { name: 'AdminDeleteUserCommand' } }],
        },
        {
          code: 'const q = `DELETE FROM patients WHERE id = ${id}`;',
          errors: [{ messageId: 'bannedSql' }],
        },
        {
          code: "const q = 'TRUNCATE TABLE patients';",
          errors: [{ messageId: 'bannedSql' }],
        },
        {
          code: "const q = 'DROP TABLE patients';",
          errors: [{ messageId: 'bannedSql' }],
        },
        {
          code: "const q = 'DROP DATABASE prod';",
          errors: [{ messageId: 'bannedSql' }],
        },
        {
          code: "const a = 's3:DeleteObjectTagging';",
          filename: 'services/api/src/policy.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObjectTagging' } }],
        },
        {
          // Deny effect, but outside infra/ — the allowlist is scoped to infra/ constructs.
          code: "const stmt = { effect: 'Deny', actions: ['s3:DeleteObject'] };",
          filename: 'services/api/src/policy.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObject' } }],
        },
        {
          // Inside infra/, but Allow, not Deny.
          code: "const stmt = { effect: 'Allow', actions: ['s3:DeleteObject'] };",
          filename: 'infra/src/stack.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObject' } }],
        },
        {
          // Inside infra/, no effect property at all.
          code: "const stmt = { actions: ['s3:DeleteObjectVersion'] };",
          filename: 'infra/src/stack.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObjectVersion' } }],
        },
        {
          // Inside infra/, but no enclosing object literal at all.
          code: "const action = 's3:DeleteObject';",
          filename: 'infra/src/stack.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObject' } }],
        },
        {
          // Inside infra/, enclosing object has a spread element (not a plain
          // Property) and still no matching effect: Deny.
          code: "const stmt = { ...base, actions: ['s3:DeleteObject'] };",
          filename: 'infra/src/stack.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObject' } }],
        },
        {
          // Inside infra/, effect present but neither a string nor a MemberExpression.
          code: "const stmt = { effect: true, actions: ['s3:DeleteObject'] };",
          filename: 'infra/src/stack.js',
          errors: [{ messageId: 'bannedS3Delete', data: { action: 's3:DeleteObject' } }],
        },
      ],
    });
  });
});
