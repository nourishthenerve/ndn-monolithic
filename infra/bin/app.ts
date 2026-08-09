import { App } from 'aws-cdk-lib';

import { ACCOUNT_ID, REGION } from '../src/config.js';
import { WebStack } from '../src/web-stack.js';

const app = new App();

new WebStack(app, 'NdnWebStack', {
  env: { account: ACCOUNT_ID, region: REGION },
  deployVersion: process.env.GITHUB_SHA ?? 'local',
});
