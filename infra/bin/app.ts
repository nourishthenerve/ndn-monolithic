import { App, Tags } from 'aws-cdk-lib';

import { AuthStack } from '../src/auth-stack.js';
import { BudgetStack } from '../src/budget-stack.js';
import {
  ACCOUNT_ID,
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
  LOAD_TEST_DATA_STACK_ID,
  LOAD_TEST_LABEL,
  LOAD_TEST_WEB_STACK_ID,
  PR_STACK_ID_PREFIX,
  REGION,
} from '../src/config.js';
import { DataStack } from '../src/data-stack.js';
import { enforceLogRetention } from '../src/log-retention.js';
import { WebStack } from '../src/web-stack.js';

const app = new App();

// TASK 0.5.1: applies to every taggable resource in every stack below —
// see budget-stack.ts for the three resources that need it passed
// explicitly instead.
Tags.of(app).add(COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE);

// TASK 0.5.2 (R-11): app-wide safety net — any log group in any stack below
// that doesn't go through log-retention.ts's createLogGroup() still gets
// capped at 14 days rather than defaulting to infinite retention.
enforceLogRetention(app);

// TASK 0.6.3: CI's pr-environment job sets PR_NUMBER (github.event.number)
// so a single `cdk deploy`/`cdk destroy` invocation targets exactly one
// short-lived, uniquely-named stack — WebStack only, no BudgetStack (a
// per-PR budget/alarm makes no sense for a stack that's gone within the
// same run) — and never the production stacks. ndn-deploy-pr's own IAM
// policy independently enforces this same boundary by ARN pattern
// (docs/runbooks/ephemeral-pr-environments.md); this branch is what makes
// the CDK app agree with that boundary rather than merely not violate it.
const prNumber = process.env.PR_NUMBER;
// TASK 5.1.1: a human-triggered, single-copy disposable stack for
// `docs/runbooks/load-testing.md`'s own run — not CI-triggered like
// `PR_NUMBER` above, and not per-PR: exactly one exists at a time, so its
// two stack ids and its `DataStack`/`WebStack` `prLabel` are fixed
// constants rather than a number substituted in. Deliberately no
// `AuthStack` here — `NdnAuthStack`'s pools are `RETAIN` plus deletion
// protection precisely so a disposable copy is never created (see
// `AuthStack` below), and `DataStack`/`WebStack`'s Lambdas already resolve
// Cognito identifiers from `config.ts`'s fixed constants rather than a
// cross-stack reference — so this disposable copy authenticates against
// the same real, already-provisioned production pools a real signed-in
// test principal already exists in (`docs/runbooks/load-testing.md`'s own
// test identities, shared with TASK 5.3.1's).
const loadTest = process.env.LOAD_TEST;

if (loadTest) {
  const loadTestDataStack = new DataStack(app, LOAD_TEST_DATA_STACK_ID, {
    env: { account: ACCOUNT_ID, region: REGION },
    ephemeral: true,
    prLabel: LOAD_TEST_LABEL,
  });

  new WebStack(app, LOAD_TEST_WEB_STACK_ID, {
    env: { account: ACCOUNT_ID, region: REGION },
    deployVersion: process.env.GITHUB_SHA ?? 'local',
    ephemeral: true,
    prLabel: LOAD_TEST_LABEL,
    table: loadTestDataStack.table,
    authorizerFunction: loadTestDataStack.authorizerFunction,
  });
} else if (prNumber) {
  new WebStack(app, `${PR_STACK_ID_PREFIX}${prNumber}`, {
    env: { account: ACCOUNT_ID, region: REGION },
    deployVersion: process.env.GITHUB_SHA ?? 'local',
    ephemeral: true,
    prLabel: `pr-${prNumber}`,
  });
} else {
  // TASK 1.3.1: production only, same as BudgetStack below — an ephemeral
  // per-PR stack (0.6.3) doesn't need its own table; DataStack's resources
  // aren't behind the PR-environment integration/a11y suite today, so
  // standing one up per PR would only add cost/time with no test coverage
  // exercising it. TASK 1.5.2: created before WebStack (reordered from this
  // file's previous WebStack-then-DataStack sequence) so its table can be
  // passed into WebStack's own props below — WebStack's Stripe webhook
  // function needs it (see web-stack.ts's own TASK 1.5.2 comment); nothing
  // here flows the other way, so this is a one-directional cross-stack
  // reference, not the circular shape MediaUploadFunction's comment
  // documents.
  const dataStack = new DataStack(app, 'NdnDataStack', {
    env: { account: ACCOUNT_ID, region: REGION },
  });

  new WebStack(app, 'NdnWebStack', {
    env: { account: ACCOUNT_ID, region: REGION },
    deployVersion: process.env.GITHUB_SHA ?? 'local',
    table: dataStack.table,
    // TASK 2.2.2: one authorizer function, both APIs. Same one-directional
    // cross-stack reference `table` above already establishes — nothing
    // flows back from WebStack to DataStack.
    authorizerFunction: dataStack.authorizerFunction,
  });

  new BudgetStack(app, 'NdnBudgetStack', {
    env: { account: ACCOUNT_ID, region: REGION },
  });

  // TASK 2.2.1: production only, for DataStack's reason above and one of
  // its own — these pools are RETAIN plus deletion protection, so an
  // ephemeral per-PR copy would be a directory nothing could clean up.
  // No cross-stack reference in either direction yet: nothing is in front
  // of the pools until 2.2.2's authorizer, and the identifiers this stack
  // exports reach the rest of the estate through config.ts rather than a
  // CloudFormation export, so the stacks can deploy in any order.
  new AuthStack(app, 'NdnAuthStack', {
    env: { account: ACCOUNT_ID, region: REGION },
    // TASK 2.2.3: the patient pool's Post-Confirmation trigger. Same
    // one-directional DataStack -> consumer reference `table` and
    // `authorizerFunction` already use.
    postConfirmationFunction: dataStack.postConfirmationFunction,
  });
}
