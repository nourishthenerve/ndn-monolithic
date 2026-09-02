// TASK 0.4.1: first CDK stack that deploys real resources — S3 site bucket,
// CloudFront (OAC-only, no public S3 access), an imported/pre-validated ACM
// certificate, a same-origin HTTP API + health Lambda behind CloudFront, and
// security response headers. See docs/plan/05-execution-plan.md and
// docs/runbooks/iac-baseline.md.

import { fileURLToPath } from 'node:url';

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Certificate, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  type ErrorResponse,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  Function as CloudFrontFunction,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import {
  LambdaApplication,
  LambdaDeploymentConfig,
  LambdaDeploymentGroup,
} from 'aws-cdk-lib/aws-codedeploy';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Alias, Architecture, Runtime, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import {
  APEX_DOMAIN_NAME,
  AUTH_CALLBACK_URL,
  AUTH_SIGN_OUT_URL,
  CLINICIAN_OAUTH_BASE_URL,
  CLINICIAN_USER_POOL_CLIENT_ID,
  CERTIFICATE_ARN,
  CONTACT_FORM_FROM_EMAIL,
  DOMAIN_NAME,
  PATIENT_OAUTH_BASE_URL,
  PATIENT_USER_POOL_CLIENT_ID,
  PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME,
  SES_CONFIGURATION_SET_NAME,
  SES_EMAIL_IDENTITY_DOMAIN,
  SMS_ORIGINATION_IDENTITY,
  STRIPE_SECRET_KEY_PARAMETER_NAME,
  SITE_ORIGIN,
  STRIPE_WEBHOOK_SECRET_PARAMETER_NAME,
  WWW_DOMAIN_NAME,
} from './config.js';
import { createEmailEventPipeline } from './email-events.js';
import { FLAG_ENVIRONMENT, grantFlagReads } from './flag-parameters.js';
import {
  attachAuditPartitionReadGuardrail,
  attachDestructiveActionGuardrail,
} from './guardrails.js';
import { createLogGroup } from './log-retention.js';
import { createRequestAuthorizer, PUBLIC_ROUTE } from './route-protection.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

export interface WebStackProps extends StackProps {
  /** Deploying commit SHA, surfaced by /health. Falls back to 'local'. */
  readonly deployVersion?: string;
  /**
   * TASK 0.6.3: true for a short-lived per-PR stack. Ephemeral stacks skip
   * the custom domain/certificate entirely (CloudFront rejects a second
   * distribution aliasing the same domain — this would collide with prod's
   * `next.nourishthenerve.com`) and serve on their own unique
   * `*.cloudfront.net` domain instead. Defaults to false (production shape,
   * unchanged).
   */
  readonly ephemeral?: boolean;
  /**
   * TASK 0.6.3: a short, unique label (e.g. `pr-123`) mixed into explicit
   * log group names so two ephemeral stacks deployed concurrently (two
   * open PRs) never collide — CloudWatch Logs group names are a flat
   * per-account/region namespace, not scoped by CloudFormation stack.
   * Required when `ephemeral` is true; ignored otherwise (production keeps
   * its fixed, documented `/ndn/*` names).
   */
  readonly prLabel?: string;
  /**
   * TASK 1.5.2: `NdnDataStack`'s table (data-stack.ts), passed in so the
   * Stripe webhook function here can confirm/cancel registrations —
   * infra/bin/app.ts wires this for the production stack only. Optional
   * because no `DataStack` is deployed alongside an ephemeral per-PR stack
   * (0.6.3's own comment on why); when absent, the webhook function/route/
   * CloudFront behavior are skipped entirely rather than deployed
   * non-functional.
   */
  readonly table?: ITable;
  /**
   * TASK 2.2.2: `NdnDataStack`'s authorizer function (data-stack.ts),
   * passed in so this API's protected routes go through the same
   * verification as that one's — one function, two authorizer constructs,
   * because an API Gateway authorizer belongs to exactly one API.
   *
   * Optional for the same reason `table` is: no `DataStack` is deployed
   * alongside an ephemeral per-PR stack. When absent this API simply has
   * no default authorizer — which is safe today only because every
   * override-free route is gated on this prop being present at
   * construction (TASK 2.5.4's `if (props.authorizerFunction)`, the same
   * shape `if (props.table)` already uses above) or is explicitly
   * `PUBLIC_ROUTE`, and web-stack.test.ts asserts exactly that.
   */
  readonly authorizerFunction?: IFunction;
}

export class WebStack extends Stack {
  /**
   * TASK 1.5.1: workshop poster images — versioned, private (OAC-only,
   * never a public bucket/listing), `RemovalPolicy.RETAIN` like every other
   * protected resource in this repo. Exposed so infra/bin/app.ts can pass
   * it into DataStack, whose MediaUploadFunction is the only role ever
   * granted `s3:PutObject` against it (never DeleteObject) — see
   * data-stack.ts's own TASK 1.5.1 comment.
   */
  public readonly mediaBucket: Bucket;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const siteBucket = new Bucket(this, 'SiteBucket', {
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Matches every other protected resource in this repo: never
      // auto-deleted by code, even on `cdk destroy` of this stack —
      // for production. TASK 5.2.1's own security review found this had
      // been unconditional since TASK 0.6.3 first added `ephemeral`: every
      // per-PR stack's own SiteBucket/MediaBucket RETAINed too, and
      // `cdk destroy` orphans a RETAINed bucket rather than deleting it —
      // 76 of them, back to PR #23, none caught by the CI job's own
      // "zero standing cost" assertion, which checks only that the *stack*
      // is gone. `ephemeral` ? DESTROY, with `autoDeleteObjects` (needed
      // because DESTROY alone still refuses to delete a non-empty bucket)
      // closes it for every future PR; the 76 already-orphaned buckets
      // were removed directly (`docs/runbooks/aws-account-baseline.md`).
      //
      // **A named, accepted residual, not a second silent leak.**
      // `autoDeleteObjects` is CDK's own singleton
      // `Custom::S3AutoDeleteObjectsCustomResourceProvider` Lambda — built
      // via a raw `CfnResource`, not `aws-cdk-lib/aws-lambda`'s
      // `CfnFunction` class, so `log-retention.ts`'s
      // `ExplicitLambdaLogGroupAspect` (`node instanceof CfnFunction`)
      // does not see it and cannot fail synth on it the way it would a
      // function this repo owns. It has no public prop to give it an
      // explicit log group. Its own CloudWatch group is therefore the
      // same shape `BucketDeployment`'s was before that fix — one small,
      // infinite-retention group per ephemeral stack — except this one is
      // invoked only at delete time, so its log volume is a handful of
      // lines, not a per-deploy stream. Left as a real, small, tracked gap
      // rather than solved here: closing it needs either a CDK upstream
      // fix or widening the aspect to match by CloudFormation resource
      // type rather than TS class, both bigger than this task's own scope.
      // `docs/runbooks/aws-account-baseline.md` names the periodic manual
      // check until one of those lands.
      removalPolicy: props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: props.ephemeral,
    });

    // TASK 1.5.1: same shape as siteBucket — versioned, private, retained.
    // Workshop posters are deliberately public marketing collateral once
    // published (served via the `/media/*` CloudFront behavior below,
    // Origin Access Control only, no signed URLs), but the bucket itself
    // stays exactly as locked-down as ADR-0005 requires: no public bucket,
    // no public listing, no object public by default. See
    // docs/plan/05-execution-plan.md TASK 1.5.1's own note on this
    // distinction.
    const mediaBucket = new Bucket(this, 'MediaBucket', {
      versioned: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Same TASK 5.2.1 correction as `siteBucket` above, same reasoning.
      removalPolicy: props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: props.ephemeral,
      // **2026-09-01: the bucket had no CORS rule at all, so every
      // browser-side upload this codebase has ever offered was dead.**
      //
      // A presigned `PutObject` URL points at S3's own hostname, so the
      // browser's `PUT` is cross-origin and preflighted. With no rule, S3
      // answers the `OPTIONS` without the allow headers and the browser
      // refuses to send the real request — the fetch rejects, and the page
      // can only say "that file could not be uploaded", which is exactly
      // what the owner saw. Nothing reaches S3, so nothing appears in any
      // log: the identical silent shape as the API's own two CORS defects
      // (`allowOrigins` naming only `next.`, then `PATCH` missing from
      // `allowMethods`), and found the same way — by asking why a request
      // had left no trace anywhere.
      //
      // It went unnoticed because the only prior consumer was TASK 1.5.1's
      // workshop-poster upload, which the handler tests and `curl` both
      // exercise without preflighting. The assessment attachments added
      // 2026-09-01 are the first feature anyone actually used from a
      // browser.
      //
      // Scoped deliberately: the three origins the API's own
      // `corsPreflight` already names, `PUT` alone (`GET` is not here —
      // an attachment is fetched through a presigned URL the browser
      // navigates to, not through XHR, and a poster is served by
      // CloudFront from the same origin), and `ETag` exposed because that
      // is the one response header an uploader has any use for.
      cors: [
        {
          allowedOrigins: [SITE_ORIGIN, `https://${WWW_DOMAIN_NAME}`, `https://${DOMAIN_NAME}`],
          allowedMethods: [HttpMethods.PUT],
          allowedHeaders: ['content-type'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });
    this.mediaBucket = mediaBucket;

    // TASK 0.6.3: an ephemeral stack has no custom domain, so it has no
    // matching ACM certificate either — CloudFront ties ViewerCertificate
    // to the exact set of Aliases, so the two are skipped together.
    const certificate: ICertificate | undefined = props.ephemeral
      ? undefined
      : Certificate.fromCertificateArn(this, 'Certificate', CERTIFICATE_ARN);

    const logGroupName = (baseName: string): string =>
      props.ephemeral && props.prLabel ? `/ndn/${props.prLabel}/${baseName}` : `/ndn/${baseName}`;

    const healthFunction = new NodejsFunction(this, 'HealthFunction', {
      entry: `${moduleDir}../../services/api/src/health.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(5),
      environment: {
        DEPLOY_VERSION: props.deployVersion ?? 'local',
      },
      // TASK 0.5.2 (R-11): explicit log group so retention is 14 days from
      // the first deploy — Lambda's own auto-created group defaults to
      // "never expire".
      logGroup: createLogGroup(this, 'HealthFunctionLogGroup', logGroupName('health-function')),
    });

    // TASK 0.6.2: publishing a Version + Alias, and routing every caller
    // (API Gateway below, CodeDeploy's traffic shift) through the alias
    // rather than the bare function, is what makes canary/rollback possible
    // at all — DoD's "Do NOT allow a deploy path that bypasses the alias."
    const healthAlias = new Alias(this, 'HealthAlias', {
      aliasName: 'live',
      version: healthFunction.currentVersion,
    });

    // TASK 2.2.2: same "protected unless it says otherwise" default as
    // data-stack.ts's API. `undefined` on an ephemeral per-PR stack, which
    // has no DataStack to take the function from — see WebStackProps.
    const authorizer = props.authorizerFunction
      ? createRequestAuthorizer(props.authorizerFunction)
      : undefined;

    const httpApi = new HttpApi(this, 'HttpApi', { defaultAuthorizer: authorizer });
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      authorizer: PUBLIC_ROUTE,
      integration: new HttpLambdaIntegration('HealthIntegration', healthAlias),
    });

    // Any SES sender below attaches every message to this configuration
    // set, so bounces and complaints become events and metrics rather than
    // only a silent suppression-list side effect. See email-events.ts.
    //
    // Production only. Every resource this creates is named account-
    // globally and fixed (`ndn-email`, `ndn-email-events`, two
    // `ndn-email-*` alarms), so an ephemeral per-PR copy of this stack
    // cannot create its own: CloudFormation refused with "already exists"
    // on the configuration set and both alarms the first time the
    // pr-environment job ran after this pipeline landed. Per-PR *names*
    // would be the wrong fix — the topic carries an email subscription, so
    // every PR would mail the alert address a subscription confirmation
    // for a topic destroyed minutes later. Same reasoning bin/app.ts
    // already applies to BudgetStack: an account-wide alarm makes no sense
    // for a stack that is gone within the same CI run.
    //
    // The SNS topic is the quiet half of that collision and the reason
    // this guard matters beyond a red build: `CreateTopic` is idempotent
    // by name, so it would not have errored — CloudFormation would have
    // adopted production's topic into the ephemeral stack and deleted it
    // on `cdk destroy`, leaving both production alarms pointing at
    // nothing. The three loud failures aborted the deploy before that
    // could happen.
    //
    // D-32 (2026-08-30): the contact form's own sender is deleted; only
    // StripeWebhookFunction's (D-31, dark, never wired) remains below. It
    // keeps SES_CONFIGURATION_SET_NAME and its IAM grant in ephemeral
    // stacks anyway: the name resolves to production's set, which exists
    // in the same account, and nothing in a PR environment sends mail
    // (flag-gated off, and the account is still in the SES sandbox).
    if (!props.ephemeral) {
      createEmailEventPipeline(this);
    }

    // TASK 2.2.4: the token exchange. In this stack rather than
    // data-stack.ts because it belongs to the site's own API — the one
    // CloudFront already proxies same-origin — and it touches no table at
    // all: it holds no data-plane permission of any kind, only the SSM
    // flag read every function here has.
    const authTokenRole = new Role(this, 'AuthTokenFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const authTokenFunction = new NodejsFunction(this, 'AuthTokenFunction', {
      entry: `${moduleDir}../../services/api/src/auth-token-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      // Two outbound HTTPS calls at most (Cognito's `/oauth2/token` or
      // `/oauth2/revoke`), no AWS SDK client, no table.
      timeout: Duration.seconds(10),
      role: authTokenRole,
      environment: {
        PATIENT_USER_POOL_CLIENT_ID,
        CLINICIAN_USER_POOL_CLIENT_ID,
        PATIENT_OAUTH_BASE_URL,
        CLINICIAN_OAUTH_BASE_URL,
        AUTH_CALLBACK_URL,
        AUTH_SIGN_OUT_URL,
        SITE_ORIGIN,
        ...FLAG_ENVIRONMENT,
      },
      logGroup: createLogGroup(
        this,
        'AuthTokenFunctionLogGroup',
        logGroupName('auth-token-function'),
        authTokenRole,
      ),
    });
    grantFlagReads(this, authTokenRole);

    const authIntegration = new HttpLambdaIntegration('AuthTokenIntegration', authTokenFunction);
    for (const [path, method] of [
      ['/auth/signin', HttpMethod.GET],
      ['/auth/token', HttpMethod.POST],
      ['/auth/refresh', HttpMethod.POST],
      ['/auth/signout', HttpMethod.POST],
    ] as const) {
      httpApi.addRoutes({
        path,
        methods: [method],
        // Public by definition: these are the routes a caller uses when
        // they have no token yet, or are giving one up. Putting them
        // behind the authorizer would make signing in require being
        // signed in.
        authorizer: PUBLIC_ROUTE,
        integration: authIntegration,
      });
    }

    // TASK 1.5.1 step 3: the presigned-upload endpoint for workshop
    // posters — co-located with MediaBucket (rather than in
    // infra/src/data-stack.ts, alongside the other workshop Lambdas) so its
    // role and the bucket's guardrail resource policy live in the same
    // stack. A cross-stack version was tried first and produces a real
    // circular CloudFormation dependency: DataStack would need
    // mediaBucket's ARN (WebStack -> DataStack... no, DataStack ->
    // WebStack for the bucket), while the guardrail's bucket-policy half
    // needs the role's ARN written into *this* stack's bucket policy
    // (WebStack -> DataStack for the role) — two opposite-direction
    // references, an unresolvable cycle. This function needs no DynamoDB
    // access at all, so keeping it here avoids the cycle entirely.
    //
    // TASK 2.5.4: gated on `props.authorizerFunction` the same way the
    // Stripe webhook function above is gated on `props.table` — this route
    // now authenticates with `can()` against a real clinician `Principal`,
    // which an ephemeral per-PR stack (no `DataStack`, no authorizer
    // function) has no way to produce. Before this task the route stood on
    // `ADMIN_TOKEN_ROUTE`, which needed no authorizer function to be safe;
    // falling through to `defaultAuthorizer` when that prop is absent would
    // leave the route with `AuthorizationType: NONE` — wide open, not
    // merely unauthenticated in the deliberate way `PUBLIC_ROUTE_KEYS`
    // means it. Not building the function or its route at all is the same
    // "closed, not open" default `route-protection.ts`'s own header states.
    if (props.authorizerFunction) {
      const mediaUploadRole = new Role(this, 'MediaUploadFunctionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      });

      const mediaUploadFunction = new NodejsFunction(this, 'MediaUploadFunction', {
        entry: `${moduleDir}../../services/api/src/media-upload-handler.ts`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(5),
        role: mediaUploadRole,
        environment: {
          MEDIA_BUCKET_NAME: mediaBucket.bucketName,
          ...FLAG_ENVIRONMENT,
        },
        logGroup: createLogGroup(
          this,
          'MediaUploadFunctionLogGroup',
          logGroupName('media-upload-function'),
          mediaUploadRole,
        ),
      });
      grantFlagReads(this, mediaUploadRole);

      // Scoped to the workshops/ prefix only (media-upload.ts's
      // WORKSHOP_MEDIA_PREFIX) — TASK 1.5.1's own DoD: "the runtime role
      // gets PutObject only, never DeleteObject," narrowed further than
      // the guardrail's own bucket-wide Deny to the one prefix this
      // function's presigned URLs ever target.
      mediaUploadRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'MediaUploadPutWorkshopPosters',
          effect: Effect.ALLOW,
          actions: ['s3:PutObject'],
          resources: [`${mediaBucket.bucketArn}/workshops/*`],
        }),
      );
      // TASK 1.5.1 step 1: "Attach 0.3.2's attachDestructiveActionGuardrail
      // to the runtime role against this bucket immediately." Bucket-wide
      // (not just workshops/*), matching every other guardrail call in
      // this repo.
      attachDestructiveActionGuardrail(mediaUploadRole, { buckets: [mediaBucket], tables: [] });

      // No `authorizer:` override — `defaultAuthorizer` (the real Lambda
      // authorizer, shared from DataStack) applies. No new IAM grant
      // needed for that: `can()` is a pure function of the principal the
      // authorizer already resolved, not a second AWS call.
      httpApi.addRoutes({
        path: '/workshops/media-upload-url',
        methods: [HttpMethod.POST],
        integration: new HttpLambdaIntegration('MediaUploadIntegration', mediaUploadFunction),
      });
    }

    // 2026-09-01: the assessment-attachment upload endpoint — "Inside those
    // 3 sections there will be option to upload audio file, video file,
    // pictures, word files, pdfs etc."
    //
    // **In this stack, not data-stack.ts**, for the reason
    // `MediaUploadFunction` above spells out: the bucket lives here, and a
    // DataStack function needing its ARN while this stack's bucket policy
    // needs that function's role ARN is an unresolvable CloudFormation
    // cycle. Unlike the workshop uploader, this one *does* need the table
    // — it resolves `assigned_clinician_id` so `can()` can tell an
    // assigned clinician from an unassigned one — which is the same
    // one-directional WebStack → DataStack reference `StripeWebhookFunction`
    // below already makes. Hence the `props.table` half of the condition.
    if (props.authorizerFunction && props.table) {
      const assessmentUploadRole = new Role(this, 'AssessmentUploadFunctionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      });

      const assessmentUploadFunction = new NodejsFunction(this, 'AssessmentUploadFunction', {
        entry: `${moduleDir}../../services/api/src/assessment-upload-handler.ts`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(5),
        role: assessmentUploadRole,
        environment: {
          MEDIA_BUCKET_NAME: mediaBucket.bucketName,
          PRINCIPAL_TABLE_NAME: props.table.tableName,
          AUDIT_TABLE_NAME: props.table.tableName,
          ...FLAG_ENVIRONMENT,
        },
        logGroup: createLogGroup(
          this,
          'AssessmentUploadFunctionLogGroup',
          logGroupName('assessment-upload-function'),
          assessmentUploadRole,
        ),
      });
      grantFlagReads(this, assessmentUploadRole);

      // `PutObject` and `GetObject` on the `assessments/` prefix only —
      // never `workshops/`, and never `DeleteObject`. The same narrowing
      // `MediaUploadPutWorkshopPosters` above applies to its own prefix,
      // and the mirror image of it: neither function can reach into the
      // other's half of the bucket.
      //
      // **`GetObject` is here because nothing else serves these files.**
      // The `/media/*` CloudFront behaviour below hands the bucket to
      // anyone who knows a path, which is correct for a workshop poster
      // and would be indefensible for a clinical recording — and it does
      // not reach this prefix. An attachment is readable only through this
      // function's presigned GET, behind the same section-level `can()`
      // check that governs the record it belongs to.
      assessmentUploadRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'AssessmentUploadPutAndGetAttachments',
          effect: Effect.ALLOW,
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [`${mediaBucket.bucketArn}/assessments/*`],
        }),
      );
      // `GetItem` on the patient partition, and nothing else — this
      // function reads one field of one row to resolve a care
      // relationship. It cannot write the assessment record its URLs are
      // for; that is `AssessmentFunction`'s, on a separate role, and is a
      // separate authorisation on a separate route.
      assessmentUploadRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'ReadPatientForAttachmentAuthorisation',
          effect: Effect.ALLOW,
          actions: ['dynamodb:GetItem'],
          resources: [props.table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAT#*'] } },
        }),
      );
      attachDestructiveActionGuardrail(assessmentUploadRole, {
        buckets: [mediaBucket],
        tables: [props.table],
      });
      attachAuditPartitionReadGuardrail(assessmentUploadRole, props.table);

      // **`/attachments/*`, not `/patients/*` — 2026-09-02, and the
      // original paths were unreachable.**
      //
      // These routes are on *this* stack's `HttpApi`, because the function
      // needs the media bucket and the bucket is here (see the cycle this
      // file's `MediaUploadFunction` comment describes). The browser,
      // however, calls `site-config.ts`'s `contentApiUrl`, which is
      // `NdnDataStack`'s **separate** `ContentHttpApi`. So a request to
      // `POST /patients/…/attachment-upload-url` reached an API that had
      // never heard of it and answered `404` — every upload failed, and
      // the page could only say "that file could not be uploaded".
      //
      // Proven rather than reasoned about: the same probe returns `401`
      // for a real DataStack route and `404` for these.
      //
      // The fix is the shape `/auth/*` has used since TASK 2.2.4 — a
      // CloudFront behaviour proxying a distinctive prefix to this API, so
      // the browser calls it **same-origin**. That also removes the need
      // for CORS on this API entirely, which it does not have.
      //
      // The prefix is `/attachments/` rather than `/patients/` so the
      // behaviour cannot shadow anything else and reads as what it is; the
      // ids stay in the path, so the handler's own parameters are
      // unchanged.
      const assessmentUploadIntegration = new HttpLambdaIntegration(
        'AssessmentUploadIntegration',
        assessmentUploadFunction,
      );
      httpApi.addRoutes({
        path: '/attachments/{id}/{assessmentId}/upload-url',
        methods: [HttpMethod.POST],
        integration: assessmentUploadIntegration,
      });
      // `POST`, not `GET`, for a read: the object key would otherwise sit
      // in a URL, and therefore in every access log between here and the
      // browser. A key names a patient and a section.
      httpApi.addRoutes({
        path: '/attachments/{id}/{assessmentId}/download-url',
        methods: [HttpMethod.POST],
        integration: assessmentUploadIntegration,
      });
    }

    // TASK 1.5.2 (ADR-0010): the Stripe webhook function/route — placed
    // here (not alongside the checkout function in data-stack.ts) so it's
    // reachable at a stable custom-domain URL (`https://next.nourishthenerve.com/stripe/webhook`,
    // proxied through this distribution below, same same-origin shape
    // `/health` above already uses) for registering in the Stripe
    // dashboard — a raw
    // `execute-api.amazonaws.com` URL is fine functionally but isn't
    // guaranteed stable if `NdnDataStack`'s HttpApi is ever recreated. This
    // is the one function in this stack that needs `NdnDataStack`'s table
    // (`props.table`, a cross-stack reference wired by infra/bin/app.ts) —
    // a one-directional WebStack -> DataStack dependency, not the circular
    // shape `MediaUploadFunction`'s own comment above describes (DataStack
    // needs nothing back from WebStack for this). No ephemeral per-PR stack
    // deploys a DataStack (0.6.3's own comment), so `props.table` is
    // undefined there and this whole block — function, route, CloudFront
    // behavior — is skipped rather than deployed non-functional.
    let stripeWebhookFunction: NodejsFunction | undefined;
    if (props.table) {
      const stripeWebhookRole = new Role(this, 'StripeWebhookFunctionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      });

      stripeWebhookFunction = new NodejsFunction(this, 'StripeWebhookFunction', {
        entry: `${moduleDir}../../services/api/src/stripe-webhook-handler.ts`,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: 128,
        timeout: Duration.seconds(10),
        role: stripeWebhookRole,
        environment: {
          WORKSHOP_TABLE_NAME: props.table.tableName,
          // TASK 2.1.3: the same table, named separately for the audit
          // rows confirm/cancel now write durably (data-stack.ts sets the
          // same pair on every function that writes through a repository).
          AUDIT_TABLE_NAME: props.table.tableName,
          // TASK workshop-confirmation-sms: same table again, named for the
          // delivery-log/spend-cap partitions the Notifier's SMS guard chain
          // reads and writes — same convention reminder-sweep's own
          // NOTIFICATION_TABLE_NAME in data-stack.ts documents.
          NOTIFICATION_TABLE_NAME: props.table.tableName,
          SMS_ORIGINATION_IDENTITY,
          STRIPE_WEBHOOK_SECRET_PARAMETER_NAME,
          STRIPE_SECRET_KEY_PARAMETER_NAME,
          CONTACT_FORM_FROM_EMAIL,
          SES_CONFIGURATION_SET_NAME,
          ...FLAG_ENVIRONMENT,
        },
        logGroup: createLogGroup(
          this,
          'StripeWebhookFunctionLogGroup',
          logGroupName('stripe-webhook-function'),
          stripeWebhookRole,
        ),
      });

      // TASK workshop-confirmation-sms: sms.ts's guard chain reads SMS
      // feature flags (kill switch etc.) via SSM — same grant every other
      // function that constructs a real Notifier/SmsSender already needs
      // (data-stack.ts's reminder-sweep role).
      grantFlagReads(this, stripeWebhookRole);

      props.table.grantReadData(stripeWebhookRole);
      // Precise write actions only — same reasoning WorkshopCheckoutWrite
      // (data-stack.ts) documents: DynamoRegistrationStore.update and the
      // webhook-idempotency row both use PutCommand, capacity release uses
      // UpdateCommand — never table.grantWriteData()'s broader
      // DeleteItem-including grant.
      stripeWebhookRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'StripeWebhookWrite',
          effect: Effect.ALLOW,
          actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [props.table.tableArn],
        }),
      );
      attachDestructiveActionGuardrail(stripeWebhookRole, { buckets: [], tables: [props.table] });
      // TASK 2.1.3 step 4: this role's `dynamodb:PutItem` above is what
      // appends its audit rows; this denies it every way of reading them
      // back, the same pair every writing role in data-stack.ts carries.
      attachAuditPartitionReadGuardrail(stripeWebhookRole, props.table);
      stripeWebhookRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'ReadStripeSecrets',
          effect: Effect.ALLOW,
          actions: ['ssm:GetParameter'],
          resources: [
            Stack.of(this).formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: STRIPE_WEBHOOK_SECRET_PARAMETER_NAME.replace(/^\//, ''),
            }),
            Stack.of(this).formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: STRIPE_SECRET_KEY_PARAMETER_NAME.replace(/^\//, ''),
            }),
          ],
        }),
      );
      // Scoped to exactly the one verified sending identity and the one
      // configuration set — the registration-confirmation email reuses
      // both, not a second of either.
      stripeWebhookRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'SendRegistrationConfirmationEmail',
          effect: Effect.ALLOW,
          actions: ['ses:SendEmail'],
          resources: [
            Stack.of(this).formatArn({
              service: 'ses',
              resource: 'identity',
              resourceName: SES_EMAIL_IDENTITY_DOMAIN,
            }),
            Stack.of(this).formatArn({
              service: 'ses',
              resource: 'configuration-set',
              resourceName: SES_CONFIGURATION_SET_NAME,
            }),
          ],
        }),
      );
      // TASK workshop-confirmation-sms: the Notifier's SMS attempt, tried
      // before the email fallback above. Unscoped resources for now, same
      // temporary posture data-stack.ts's own SendReminderSms statement
      // documents — narrow to the leased identity's own ARN once LL-02
      // provisions one.
      stripeWebhookRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: 'SendRegistrationConfirmationSms',
          effect: Effect.ALLOW,
          actions: ['sms-voice:SendTextMessage'],
          resources: ['*'],
        }),
      );

      httpApi.addRoutes({
        path: '/stripe/webhook',
        methods: [HttpMethod.POST],
        authorizer: PUBLIC_ROUTE,
        integration: new HttpLambdaIntegration('StripeWebhookIntegration', stripeWebhookFunction),
      });
    }

    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          override: true,
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { override: true, frameOption: HeadersFrameOption.DENY },
        referrerPolicy: {
          override: true,
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        },
        contentSecurityPolicy: {
          override: true,
          // TASK 1.4.1: script-src/frame-src name the Turnstile origin
          // explicitly — default-src 'self' alone would otherwise block
          // both the widget script and the challenge iframe it embeds.
          // TASK 1.5.2: script-src/frame-src also name Stripe's origins —
          // a future Stripe.js `redirectToCheckout()` call needs
          // `https://js.stripe.com`, and the Checkout page itself (if ever
          // embedded rather than top-level-navigated to) needs
          // `https://checkout.stripe.com`. Both scoped to exactly these
          // origins, not widened generally.
          //
          // **Found live, 2026-08-27, the first time `auth.webSignIn.enabled`
          // was ever turned on in production:** every `client:only="react"`
          // island — the *entire* authenticated account shell (index,
          // patient, caseload, content, messages, call, callback; every
          // page TASK 2.2.4 through 4.5.1 built) — silently failed to
          // hydrate. Astro's own hydration runtime for `client:only` emits
          // two small inline `<script>` blocks (never a `src=` file) that
          // define `window.Astro.only` and register the `<astro-island>`
          // custom element; a `script-src` with no `'unsafe-inline'`, hash,
          // or nonce blocks both outright, so the custom element never
          // upgrades and nothing — not even RequireAuth's own loading
          // state — ever renders. No prior task caught this because every
          // "Verification" line through Phase 4 checked the *build output*
          // (`dist/index.html` exists, the route resolves 200) or ran axe
          // against an unauthenticated per-PR stack — never a real,
          // signed-in, rendered DOM, which is exactly the gap TASK 5.3.1
          // exists to close. This fix predates 5.3.1's own first live run.
          //
          // The hashes are Astro's fixed, per-build-version runtime
          // boilerplate — identical across every island on every page
          // (confirmed: byte-identical on both a one-island and a
          // two-island page) — not per-page or per-component content.
          //
          // **A third joins them 2026-09-02**, and it is a different
          // directive from the first two: they are `client:only`'s, this
          // one is `client:load`'s (`(self.Astro||...).load = …`, then a
          // dispatched `astro:load`). The blog and workshop listings moved
          // to `client:load` so their build-time content stays in the HTML
          // for crawlers while the island reconciles a live list on top —
          // `apps/web/src/blog/LiveBlogList.tsx` has the reasoning. A
          // `client:only` island would have emitted no such script and no
          // such markup, which is precisely what those two pages must not
          // do.
          // `apps/web/src/auth/csp-inline-scripts.test.ts` scans the real
          // built `dist/` output and fails if a future Astro upgrade (or
          // any new inline script anywhere on the site) ever produces a
          // hash not listed here, so a drift is caught at build time
          // rather than silently, live, again.
          //
          // **Found live, 2026-08-31, the first real authenticated form
          // submission ever driven through a real browser:** every
          // `contentApiUrl`/`signallingWebSocketUrl` call — every account
          // panel that fetches or mutates anything (caseload, patient
          // profile, clinical records, calendar, messages, next
          // appointment, patient/clinician admin, change-password, video
          // call signalling and TURN credentials; `site-config.ts`'s own
          // header already named the reason: "No CloudFront same-origin
          // proxy exists for this API yet") — was silently blocked by
          // this policy's own `connect-src` gap. With no `connect-src`
          // directive at all, CSP falls back to `default-src 'self'`,
          // which permits same-origin `/auth/*` (proxied through this
          // same distribution, this file's own `/auth/*` behaviour below)
          // but refuses every cross-origin `execute-api.amazonaws.com`
          // call outright — a browser-enforced block, invisible to any
          // server-side test, an a11y scan, or a signed-out Playwright
          // check, and only reachable by a real signed-in browser
          // actually attempting the fetch. The two origins named are
          // `apps/web/src/site-config.ts`'s own `contentApiUrl`/
          // `signallingWebSocketUrl` constants, hardcoded here the
          // identical way that file documents for its own copies —
          // `NdnDataStack`'s `HttpApi`/`WebSocketApi` are stable,
          // rarely-changing generated ids, and this stack has no live
          // cross-stack reference to either construct to read them from
          // instead.
          // **Found live, 2026-09-02, once the routes above were finally
          // reachable:** the browser got its presigned URL and was refused
          // by this very policy on the next line —
          //
          //     Fetch API cannot load https://…s3.eu-west-2.amazonaws.com/…
          //     Refused to connect because it violates the document's
          //     Content Security Policy.
          //
          // A presigned upload is a *cross-origin* `PUT` straight to S3,
          // by design — that is the whole point of presigning, and it is
          // why `mediaBucket` carries its own CORS rule. But CSP governs
          // what this document may connect to regardless of what the far
          // end permits, and S3 was never named here. Both fixes were
          // needed and neither was visible until the one before it landed;
          // this is the third and last hop on that path.
          //
          // Unlike the two `execute-api` ids above — stable, generated
          // once, in another stack this one cannot reference — the media
          // bucket is *this* stack's own construct, so it is read from it.
          // Its name is generated per stack, so every ephemeral PR
          // environment gets its own correct origin and none of them
          // inherits production's. `bucketRegionalDomainName` (not
          // `bucketDomainName`) because `assessment-upload-handler.ts`
          // presigns with a default-region `S3Client`, which signs the
          // regional endpoint — and a CSP origin must match the host the
          // browser actually calls, character for character.
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' https://challenges.cloudflare.com https://js.stripe.com " +
            "'sha256-eIXWvAmxkr251LJZkjniEK5LcPF3NkapbJepohwYRIc=' " +
            "'sha256-Ya0pUYrC7nM5Cn/056TyVuEiz6dFGrzmkWzgON0pF0U=' " +
            "'sha256-QzWFZi+FLIx23tnm9SBU4aEgx4x8DsuASP07mfqol/c='; " +
            "connect-src 'self' https://m4ptz0to5m.execute-api.eu-west-2.amazonaws.com " +
            'wss://93im3xehxh.execute-api.eu-west-2.amazonaws.com ' +
            `https://${mediaBucket.bucketRegionalDomainName}; ` +
            'frame-src https://challenges.cloudflare.com https://checkout.stripe.com; ' +
            "object-src 'none'; frame-ancestors 'none'",
        },
      },
    });

    // TASK 1.1.3: `defaultRootObject` only rewrites the true root ('/') —
    // it does not cascade to sub-paths. Against the S3 REST origin (OAC,
    // not the separate "static website hosting" endpoint, which is the one
    // that supports implicit per-prefix index documents), a request for
    // `/en` looks for an object literally named `en`; only `en/index.html`
    // exists, so without this rewrite every route but the root 403s —
    // caught by tests/pr-env/a11y-full.test.ts/keyboard.test.ts the first
    // time either was pointed at a real deployed stack rather than `/`.
    const urlRewriteFunction = new CloudFrontFunction(this, 'UrlRewriteFunction', {
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.slice(uri.lastIndexOf('/') + 1).includes('.')) {
    request.uri += '/index.html';
  }

  return request;
}
`),
    });

    // TASK 1.3.2: closes a pre-existing gap — nothing mapped a missing
    // object to a real page before this task, so any unmatched path (a
    // typo, an unpublished blog post's URL) returned the S3 origin's raw
    // 403 XML body straight through CloudFront. The private OAC origin
    // returns 403 (not 404) for a missing key — both codes are mapped here
    // to the same static page (apps/web/src/pages/404.astro), served with
    // a real 404 status so it isn't indexed as a working page.
    const notFoundErrorResponses: ErrorResponse[] = [403, 404].map((httpStatus) => ({
      httpStatus,
      responseHttpStatus: 404,
      responsePagePath: '/404.html',
    }));

    const distribution = new Distribution(this, 'Distribution', {
      priceClass: PriceClass.PRICE_CLASS_100,
      errorResponses: notFoundErrorResponses,
      // TASK 0.6.3: ephemeral stacks serve on CloudFront's own
      // *.cloudfront.net domain (always unique per distribution, already
      // TLS-covered) rather than next.nourishthenerve.com — see the
      // `certificate` comment above.
      // TASK 1.6.1: apex/www join next. here as part of the G1 cutover. This
      // deploy CANNOT succeed until the legacy claim on both names is
      // released first — CloudFront refuses an alternate domain name that any
      // distribution, in any account, already holds, which is what failed the
      // 2026-08-15 deploy. The holder was found on 2026-08-21 (AWS Support
      // case): not a third account, but the `ndn-frontend` Amplify app
      // (dty9c1kqh8zkh, eu-west-2) in 803129122420, whose Amplify-managed
      // distribution is d2z3fclxq13w3z.cloudfront.net.
      //
      // Deploy order is therefore not optional — see the runbook's cutover
      // steps: delete the Amplify domain association, confirm
      // `list-conflicting-aliases` returns Quantity: 0, and only then deploy
      // this. Deploying ahead of that release rolls the whole stack update
      // back, taking the certificate with it (the 2026-08-15 lesson that put
      // the cert on its own deploy in the first place).
      // See docs/runbooks/g1-cutover.md.
      domainNames: props.ephemeral ? undefined : [DOMAIN_NAME, APEX_DOMAIN_NAME, WWW_DOMAIN_NAME],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        // Only the S3 origin's behavior needs the clean-URL rewrite — the
        // /health behavior below is a Lambda route, not a static file, and
        // is matched by CloudFront before this default behavior applies.
        functionAssociations: [
          { function: urlRewriteFunction, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // Same-origin API (ADR 0003/D-08): /health is proxied through
        // CloudFront to the HTTP API rather than called cross-origin.
        // R-14: no-store — matches "no patient data traverses CloudFront"
        // even though /health itself carries none.
        '/health': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
        // TASK 2.2.4: `/auth/*` on the same origin as the site, which is
        // what makes the whole flow same-origin and lets 1.2.3's CSP cover
        // it with no `connect-src` exception. `ALLOW_ALL` because three of
        // the four routes are `POST` (`GET /auth/signin` is the redirect
        // that starts the flow), and caching is disabled because every
        // response either sets or spends a credential — a cached
        // `Set-Cookie` would be a session handed to the next visitor.
        //
        // **`originRequestPolicy` found missing live, 2026-08-27**, the
        // first real sign-in attempt after #109/#110 fixed hydration and
        // login-page branding: `?pool=clinician` on `GET /auth/signin`
        // silently always resolved to the patient pool. Root cause,
        // confirmed by comparing a request straight to `httpApi`'s own
        // execute-api URL (correct) against the identical request through
        // this distribution (wrong): `CachePolicy.CACHING_DISABLED` alone
        // governs only the cache *key* — with no `OriginRequestPolicy`
        // attached, CloudFront's own default forwards nothing beyond the
        // cache key to the origin at all, confirmed against the live
        // distribution's own `CachePolicy` (`QueryStringsConfig: none`,
        // `CookiesConfig: none`, `HeadersConfig: none`). That is not only
        // the query string: `POST /auth/token`'s PKCE verifier and
        // `POST /auth/refresh`'s session both live in `HttpOnly` cookies
        // (web-authentication.md), which this same gap was silently
        // stripping too — no real sign-in has ever completed through this
        // distribution. `ALL_VIEWER_EXCEPT_HOST_HEADER` (not `ALL_VIEWER`):
        // forwarding CloudFront's own `Host` header to the `execute-api`
        // origin breaks the origin's own routing, the standard reason this
        // variant exists for a non-`Host`-matching origin.
        '/auth/*': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // The same policy every other behaviour uses. Auth responses get
          // no weaker headers than a blog page.
          responseHeadersPolicy: securityHeaders,
        },
        // 2026-09-02: TASK 1.5.1's workshop-poster presign endpoint, which
        // had been on this stack's API since it was written with **no way
        // for a browser to reach it** — the same defect the attachment
        // endpoints below hit, found by the same test, and latent only
        // because nothing in `apps/web` ever called it.
        //
        // An exact path, not `/workshops/*`: that would shadow the static
        // workshop pages this distribution serves from S3.
        '/workshops/media-upload-url': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
        },
        // 2026-09-02: assessment attachments' presign endpoints, proxied
        // to this stack's own API exactly as `/auth/*` above is — see the
        // routes' own note for why they cannot live on the content API.
        // Same-origin, so no CORS is involved on this hop at all; the
        // browser's subsequent `PUT` goes straight to S3, which has its
        // own CORS rule (`MediaBucket`).
        '/attachments/*': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: securityHeaders,
        },
        // TASK 1.5.1: workshop posters, served same-origin from this
        // distribution's own domain via a second OAC origin — no signed
        // URLs (ADR-0005 note above), no cachePolicy override (defaults to
        // CACHING_OPTIMIZED, same as the default S3 behavior: these are
        // public, content-hashed-by-key static images, safe to cache at
        // the edge, unlike /health which must never cache).
        '/media/*': {
          origin: S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: securityHeaders,
        },
        // TASK 1.5.2: same same-origin proxy shape as /health — Stripe
        // posts to this domain's own /stripe/webhook path. Only present
        // when `props.table` was given (see this constructor's own
        // TASK 1.5.2 comment further up).
        ...(stripeWebhookFunction
          ? {
              '/stripe/webhook': {
                origin: new HttpOrigin(
                  `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
                ),
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: AllowedMethods.ALLOW_ALL,
                cachePolicy: CachePolicy.CACHING_DISABLED,
                responseHeadersPolicy: securityHeaders,
              },
            }
          : {}),
      },
    });

    // TASK 0.6.2: the AfterAllowTraffic hook (see docs/runbooks/rollback.md)
    // — runs once CodeDeploy has finished shifting traffic to the new
    // version, hits the live custom domain (proving DNS + cert + CDN +
    // origin + the new code all actually work), and reports Failed/
    // Succeeded back to CodeDeploy. A Failed report is what triggers the
    // automatic alias rollback. TASK 0.6.3: an ephemeral stack has no
    // custom domain to hit, so it targets the distribution's own
    // *.cloudfront.net domain instead — moot in practice, since CodeDeploy
    // only invokes this hook on an *update* to an existing alias, and every
    // ephemeral stack is created fresh and destroyed within the same CI
    // run, never updated.
    const smokeTestFunction = new NodejsFunction(this, 'SmokeTestFunction', {
      entry: `${moduleDir}../../services/api/src/smoke-test.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(30),
      environment: {
        SITE_DOMAIN: props.ephemeral ? distribution.distributionDomainName : DOMAIN_NAME,
      },
      logGroup: createLogGroup(
        this,
        'SmokeTestFunctionLogGroup',
        logGroupName('smoke-test-function'),
      ),
    });

    // TASK 0.6.2: CloudWatch alarms scoped to the alias (not the bare
    // function) so they reflect only traffic actually reaching the new
    // version during the canary window. Wired into the deployment group
    // below as the "stop and roll back automatically" trigger — separate
    // from, and faster than, the AfterAllowTraffic smoke test.
    const healthAliasErrorsAlarm = new Alarm(this, 'HealthAliasErrorsAlarm', {
      alarmDescription: 'Health Lambda alias is erroring during a canary deployment',
      metric: healthAlias.metricErrors({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const healthAliasLatencyAlarm = new Alarm(this, 'HealthAliasLatencyAlarm', {
      alarmDescription: 'Health Lambda alias latency is elevated during a canary deployment',
      // Function timeout is 5s; 3s is comfortably inside that while still
      // catching real degradation rather than ordinary cold-start jitter.
      metric: healthAlias.metricDuration({ period: Duration.minutes(1) }),
      threshold: Duration.seconds(3).toMilliseconds(),
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const healthDeploymentApplication = new LambdaApplication(this, 'HealthApplication');

    // TASK 0.6.2: this is what makes `cdk deploy` (CI's `deploy` job) shift
    // 10% of traffic to the new version, wait 5 minutes while the alarms
    // above watch it, then shift the rest — and automatically revert the
    // alias if either alarm trips or the smoke test reports Failed. See
    // docs/runbooks/rollback.md for how this was proven for real.
    const healthDeploymentGroup = new LambdaDeploymentGroup(this, 'HealthDeploymentGroup', {
      application: healthDeploymentApplication,
      alias: healthAlias,
      deploymentConfig: LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [healthAliasErrorsAlarm, healthAliasLatencyAlarm],
      postHook: smokeTestFunction,
    });

    // Pruning superseded build assets on each deploy is ordinary deploy
    // hygiene, not deletion of "patient, clinical, content or media data"
    // (00-conventions.md) — this bucket holds nothing but built static
    // assets, and stays versioned regardless. See docs/runbooks/
    // iac-baseline.md for why guardrails.ts's runtime-role deny isn't
    // wired to this bucket.
    //
    // TASK 1.1.1: source is now apps/web's real `astro build` output
    // (packages/ui's design system rendered for real), not 0.4.1's
    // placeholder page — `apps/web/dist` must exist on disk before `cdk
    // synth`/`cdk deploy` runs (CI's deploy and pr-environment jobs both
    // run `pnpm --filter @ndn/web run build` first; see ci.yml).
    new BucketDeployment(this, 'SiteDeployment', {
      sources: [Source.asset(`${moduleDir}../../apps/web/dist`)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
      // Gate G1 §4: this construct owns a Lambda of its own (CDK's
      // Custom::CDKBucketDeployment singleton), and until now it was the
      // one function in the app without an explicit log group — so every
      // deploy wrote to a group CloudFormation never knew about, with
      // infinite retention, which `cdk destroy` then left behind. Ephemeral
      // PR stacks turned that into a leak that grew per PR: 2 orphans at
      // Gate G0, 13 by the time this landed.
      //
      // Production names its own group, stack-owned and capped. An
      // ephemeral stack instead *imports* the shared, out-of-band group
      // (config.ts) rather than creating one it would have to delete: this
      // is the one Lambda that `cdk destroy` itself invokes, so a
      // stack-owned group loses a race with its own teardown — the group
      // is deleted, the Delete-event logs flush a moment later, and
      // CloudWatch recreates it bare. Measured on PR #48: the recreated
      // group's creation timestamp was 9 seconds *later* than the events
      // inside it. Importing removes the race rather than narrowing it —
      // nothing per-PR is created, so nothing per-PR is left behind.
      logGroup: props.ephemeral
        ? LogGroup.fromLogGroupName(
            this,
            'SiteDeploymentLogGroup',
            PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME,
          )
        : createLogGroup(this, 'SiteDeploymentLogGroup', logGroupName('site-deployment')),
    });

    new CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new CfnOutput(this, 'HttpApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'HealthDeploymentGroupName', {
      value: healthDeploymentGroup.deploymentGroupName,
    });
  }
}
