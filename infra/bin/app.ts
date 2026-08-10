import { App, Tags } from 'aws-cdk-lib';

import { BudgetStack } from '../src/budget-stack.js';
import {
  ACCOUNT_ID,
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
  REGION,
} from '../src/config.js';
import { WebStack } from '../src/web-stack.js';

const app = new App();

// TASK 0.5.1: applies to every taggable resource in every stack below —
// see budget-stack.ts for the three resources that need it passed
// explicitly instead.
Tags.of(app).add(COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE);

new WebStack(app, 'NdnWebStack', {
  env: { account: ACCOUNT_ID, region: REGION },
  deployVersion: process.env.GITHUB_SHA ?? 'local',
});

new BudgetStack(app, 'NdnBudgetStack', {
  env: { account: ACCOUNT_ID, region: REGION },
});
