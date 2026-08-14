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
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Alias, Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

import {
  ADMIN_API_TOKEN_PARAMETER_NAME,
  CERTIFICATE_ARN,
  CONTACT_FORM_FROM_EMAIL,
  CONTACT_FORM_TO_EMAIL,
  DOMAIN_NAME,
  SES_EMAIL_IDENTITY_DOMAIN,
  TURNSTILE_SECRET_PARAMETER_NAME,
} from './config.js';
import { attachDestructiveActionGuardrail } from './guardrails.js';
import { createLogGroup } from './log-retention.js';

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
      // auto-deleted by code, even on `cdk destroy` of this stack.
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
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

    const httpApi = new HttpApi(this, 'HttpApi');
    httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('HealthIntegration', healthAlias),
    });

    // TASK 1.4.1: the contact form's Lambda + route. A separate function
    // and role from HealthFunction — this one needs ssm:GetParameter (the
    // Turnstile secret, D-14) and ses:SendEmail, neither of which the
    // health check should ever hold. No DynamoDB/S3 access at all, so
    // guardrails.ts's destructive-action guardrail (scoped to buckets/
    // tables) doesn't apply here — see data-stack.ts for where it does.
    const contactFormRole = new Role(this, 'ContactFormFunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });

    const contactFormFunction = new NodejsFunction(this, 'ContactFormFunction', {
      entry: `${moduleDir}../../services/api/src/contact-form-handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      role: contactFormRole,
      environment: {
        TURNSTILE_SECRET_PARAMETER_NAME,
        CONTACT_FORM_FROM_EMAIL,
        CONTACT_FORM_TO_EMAIL,
      },
      logGroup: createLogGroup(
        this,
        'ContactFormFunctionLogGroup',
        logGroupName('contact-form-function'),
      ),
    });

    contactFormRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadTurnstileSecret',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: TURNSTILE_SECRET_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    // Scoped to exactly the one verified sending identity (SES supports
    // resource-level permissions on `identity/*` ARNs) — ses:SendEmail is
    // also the narrowest action this function needs, nothing broader (no
    // SendRawEmail, no template management).
    contactFormRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SendContactFormEmail',
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ses',
            resource: 'identity',
            resourceName: SES_EMAIL_IDENTITY_DOMAIN,
          }),
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/contact',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('ContactFormIntegration', contactFormFunction),
    });

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
        ADMIN_TOKEN_PARAMETER_NAME: ADMIN_API_TOKEN_PARAMETER_NAME,
      },
      logGroup: createLogGroup(this, 'MediaUploadFunctionLogGroup', logGroupName('media-upload-function')),
    });

    // Scoped to the workshops/ prefix only (media-upload.ts's
    // WORKSHOP_MEDIA_PREFIX) — TASK 1.5.1's own DoD: "the runtime role gets
    // PutObject only, never DeleteObject," narrowed further than the
    // guardrail's own bucket-wide Deny to the one prefix this function's
    // presigned URLs ever target.
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
    // (not just workshops/*), matching every other guardrail call in this
    // repo.
    attachDestructiveActionGuardrail(mediaUploadRole, { buckets: [mediaBucket], tables: [] });
    mediaUploadRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'ReadAdminApiToken',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: ADMIN_API_TOKEN_PARAMETER_NAME.replace(/^\//, ''),
          }),
        ],
      }),
    );

    httpApi.addRoutes({
      path: '/workshops/media-upload-url',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('MediaUploadIntegration', mediaUploadFunction),
    });

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
          // TASK 1.4.1: script-src/frame-src now name the Turnstile origin
          // explicitly — default-src 'self' alone would otherwise block
          // both the widget script and the challenge iframe it embeds.
          // Scoped to exactly this one origin, not widened generally.
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self' https://challenges.cloudflare.com; " +
            'frame-src https://challenges.cloudflare.com; ' +
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
      domainNames: props.ephemeral ? undefined : [DOMAIN_NAME],
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
        // TASK 1.4.1: same same-origin proxy shape as /health — the browser
        // posts to this domain's own /contact path, so the submission is
        // same-origin (no CORS needed) and covered by the CSP above. Shares
        // the /health origin (same HttpApi, both routes on it).
        '/contact': {
          origin: new HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          ),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
        },
        // TASK 1.5.1: workshop posters, served same-origin from this
        // distribution's own domain via a second OAC origin — no signed
        // URLs (ADR-0005 note above), no cachePolicy override (defaults to
        // CACHING_OPTIMIZED, same as the default S3 behavior: these are
        // public, content-hashed-by-key static images, safe to cache at
        // the edge, unlike /health and /contact which must never cache).
        '/media/*': {
          origin: S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: securityHeaders,
        },
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
