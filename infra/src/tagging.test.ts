// TASK 0.5.1's "cost allocation tags on every resource" step. Proves the
// exact wiring bin/app.ts does — `Tags.of(app).add(...)` before any stack is
// constructed — reaches ordinary taggable resources in a stack that has
// nothing to do with budgets, not just the three CE/Budgets resources
// budget-stack.test.ts covers explicitly (see budget-stack.ts's file-header
// comment for why those three needed it passed directly instead).

import { App, Tags } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';

import { COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE } from './config.js';
import { WebStack } from './web-stack.js';

describe('app-wide cost allocation tagging', () => {
  it('reaches an ordinary resource (the site bucket) in an unrelated stack', () => {
    const app = new App();
    Tags.of(app).add(COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE);
    const stack = new WebStack(app, 'TestTaggedWebStack', {
      env: { account: '357601815388', region: 'eu-west-2' },
      deployVersion: 'test-sha',
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      // arrayWith, not an exact match: the bucket also carries CDK's own
      // `aws-cdk:cr-owned:*` marker tag (from the BucketDeployment custom
      // resource) — this test only cares that ours is also present.
      Tags: Match.arrayWith([
        { Key: COST_ALLOCATION_TAG_KEY, Value: COST_ALLOCATION_TAG_VALUE },
      ]),
    });
  });
});
