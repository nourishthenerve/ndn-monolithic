// TASK 2.2.1 (ADR-0004's Gate G1 amendment): two Cognito user pools, not
// one. Cognito's MFA policy is *pool-wide* — `REQUIRED` would stack a
// second factor on top of a patient's passwordless email OTP, and
// `OPTIONAL` cannot compel a clinician to enrol — so D-09's "TOTP for
// clinicians, email-OTP for patients" does not fit in one directory. The
// gain beyond resolving that conflict is structural: a patient credential
// cannot become a clinician credential, because the two are not in the
// same directory at all.
//
// Its own stack rather than a section of web-stack.ts/data-stack.ts: these
// are the longest-lived resources in the estate (RETAIN + deletion
// protection, and "rollback is forward only" the moment a real user
// exists), and they should not share a changeset with a CloudFront
// distribution that redeploys on every content change.
//
// Nothing in front of these pools yet — no authorizer (2.2.2), no
// registration trigger (2.2.3), no sign-in UI (2.2.4). A deployed, empty
// user pool with no authorizer in front of it is inert, which is why this
// task carries no feature flag.

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  ClientAttributes,
  FeaturePlan,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  type UserPoolProps,
} from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

import {
  AUTH_CALLBACK_URL,
  AUTH_SIGN_OUT_URL,
  CLINICIAN_USER_POOL_NAME,
  PATIENT_USER_POOL_NAME,
} from './config.js';

// 60 minutes for the short-lived tokens and 30 days for the refresh token
// (TASK 2.2.1 step 6). The refresh token's life is what 2.2.4's cookie
// `Max-Age` matches, and `enableTokenRevocation` below is what makes
// 2.4.1's clinician deactivation immediate rather than eventual — without
// it, revoking a session would mean waiting out this window.
const ACCESS_TOKEN_VALIDITY = Duration.minutes(60);
const ID_TOKEN_VALIDITY = Duration.minutes(60);
const REFRESH_TOKEN_VALIDITY = Duration.days(30);

// Step 2's "no personal data in Cognito": exactly one attribute, on both
// pools. A name, a phone number or anything clinical lives in the
// DynamoDB record (`PersonRecord`'s clinical/personal split, 0.3.4) where
// the erasure story and the private-field boundary (2.1.2) can reach it —
// a copy inside a directory neither of those covers is a second, silent
// store of the same data.
const EMAIL_ONLY_ATTRIBUTES = {
  email: { required: true, mutable: true },
} as const;

// What the app clients may read and write. `emailVerified` is readable
// because the sign-in UI needs to know it; nothing is writable but the
// address itself, which self-registration (2.2.3) has to set.
const CLIENT_READ_ATTRIBUTES = new ClientAttributes().withStandardAttributes({
  email: true,
  emailVerified: true,
});
const CLIENT_WRITE_ATTRIBUTES = new ClientAttributes().withStandardAttributes({ email: true });

// Both pools share everything that is a policy rather than a role
// difference. Anything that differs between patients and clinicians is
// spelled out at the call site below, so the two are diffable.
const SHARED_POOL_PROPS = {
  // Essentials is the tier D-09 chose and the one this task re-verified
  // (docs/runbooks/cognito-user-pools.md): 10,000 MAU free, always-free,
  // $0.015/MAU beyond it against a modelled 509. It is also the floor for
  // choice-based (passwordless) sign-in — Lite cannot do email OTP at all.
  // Plus (threat protection) is deliberately not taken: it is a paid tier,
  // and the honest position is that £0 buys the directory and the MFA, not
  // the risk engine.
  featurePlan: FeaturePlan.ESSENTIALS,
  // No `username` alias: the email address *is* the sign-in identity, so
  // there is no second identifier to reconcile.
  signInAliases: { email: true },
  standardAttributes: EMAIL_ONLY_ATTRIBUTES,
  accountRecovery: AccountRecovery.EMAIL_ONLY,
  // The two halves of "a bad deploy cannot take the directory with it".
  // `deletionProtection` is Cognito's own server-side refusal (the API
  // rejects DeleteUserPool outright); `RETAIN` is CloudFormation's, so a
  // `cdk destroy` orphans the pools rather than deleting them. Neither is
  // sufficient alone — deletion protection can be turned off by an
  // UpdateUserPool call, and RETAIN only governs what CloudFormation does.
  deletionProtection: true,
  removalPolicy: RemovalPolicy.RETAIN,
} satisfies UserPoolProps;

export class AuthStack extends Stack {
  public readonly patientUserPool: UserPool;
  public readonly clinicianUserPool: UserPool;
  public readonly patientUserPoolClient: UserPoolClient;
  public readonly clinicianUserPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    this.patientUserPool = new UserPool(this, 'PatientUserPool', {
      ...SHARED_POOL_PROPS,
      userPoolName: PATIENT_USER_POOL_NAME,
      // Patients register themselves (2.2.3) and sit in `pending` until a
      // clinician approves them — approval is a state on the DynamoDB
      // record, not a gate on the directory.
      selfSignUpEnabled: true,
      // Step 3, and the one place AWS does not let this task say exactly
      // what it means. Cognito requires `PASSWORD` in
      // `AllowedFirstAuthFactors` — the console words it "The Password
      // option is always available" and CDK rejects `password: false`
      // outright — so a pool that offers *only* email OTP cannot be
      // configured. What is enforceable is the app client below: it holds
      // `ALLOW_USER_AUTH` and nothing password-shaped, so the only
      // first factor reachable through the only client that exists is the
      // email OTP. Recorded rather than papered over; the runbook carries
      // the same note.
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true,
          emailOtp: true,
          smsOtp: false,
          passkey: false,
        },
      },
      // No second factor on top of a first factor that is already a
      // one-time code sent to the same mailbox — that is friction without
      // a security gain, and it is precisely what one shared pool would
      // have forced.
      mfa: Mfa.OFF,
    });

    this.clinicianUserPool = new UserPool(this, 'ClinicianUserPool', {
      ...SHARED_POOL_PROPS,
      userPoolName: CLINICIAN_USER_POOL_NAME,
      // Step 2, and the structural half of 2.4.1: clinicians are created
      // by the principal clinician, never self-serve. Disabled at the
      // directory rather than checked in a handler, so there is no code
      // path to get wrong.
      selfSignUpEnabled: false,
      // No `signInPolicy` — the Cognito default is `PASSWORD` only, which
      // is exactly what this pool wants. Adding email OTP here would hand
      // a clinician a way past the TOTP requirement below.
      mfa: Mfa.REQUIRED,
      // SMS is off deliberately, twice over: it is a spendable path (R-02,
      // and 0.5.3's hard cap exists because of it), and a phone-number
      // factor is a weaker one than an authenticator app. Cognito enforces
      // the enrolment itself — a clinician cannot complete a first sign-in
      // without registering a TOTP device — which is the enforcement 2.4.1
      // relies on rather than reimplementing.
      mfaSecondFactor: { otp: true, sms: false },
      // CDK's own defaults, written out so they are visible in the
      // synthesized template and assertable in a test rather than
      // inherited silently.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
    });

    this.patientUserPoolClient = this.addWebClient('PatientUserPoolClient', {
      userPool: this.patientUserPool,
      clientName: `${PATIENT_USER_POOL_NAME}-web`,
      // `ALLOW_USER_AUTH` is choice-based authentication — the only flow
      // that can present an `EMAIL_OTP` challenge. Every password-shaped
      // flow is absent, so a patient account has no password path through
      // this client even though the pool policy above has to list one.
      authFlows: { user: true },
    });

    this.clinicianUserPoolClient = this.addWebClient('ClinicianUserPoolClient', {
      userPool: this.clinicianUserPool,
      clientName: `${CLINICIAN_USER_POOL_NAME}-web`,
      // SRP, not `ALLOW_USER_PASSWORD_AUTH`: the password is proved rather
      // than transmitted. Cognito follows it with the
      // `SOFTWARE_TOKEN_MFA` challenge the pool requires.
      authFlows: { userSrp: true },
    });

    // "This task deploys infrastructure and exports identifiers." The four
    // identifiers below are what 2.2.2's authorizer verifies tokens
    // against and what 2.2.4's browser client points at; they are
    // service-generated, so they cannot be constants until the first
    // deploy has run. Recording them in config.ts is the post-deploy step
    // in docs/runbooks/cognito-user-pools.md, and 2.2.2's first move.
    this.exportIdentifiers('Patient', this.patientUserPool, this.patientUserPoolClient);
    this.exportIdentifiers('Clinician', this.clinicianUserPool, this.clinicianUserPoolClient);
  }

  private addWebClient(
    id: string,
    options: { userPool: UserPool; clientName: string; authFlows: { user?: true; userSrp?: true } },
  ): UserPoolClient {
    return new UserPoolClient(this, id, {
      userPool: options.userPool,
      userPoolClientName: options.clientName,
      authFlows: options.authFlows,
      // A browser client cannot keep a secret, so it is not given one.
      // This is also the whole of what "PKCE required" can mean here:
      // Cognito has no server-side switch that rejects a code exchange
      // without a `code_verifier` — what it has is public clients, for
      // which the exchange is unauthenticated and PKCE is the only thing
      // binding the code to the requester. 2.2.4 is what must actually
      // send `code_challenge`; the honest statement of this line is "no
      // secret to leak", not "the server will refuse a non-PKCE flow".
      generateSecret: false,
      oAuth: {
        // Authorization code only. The implicit grant returns tokens in a
        // URL fragment — in history, in referrers, in logs — and client
        // credentials is a machine-to-machine flow with no user at all.
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL],
        // Step 5: `SITE_ORIGIN` and nothing else. No localhost entry, no
        // `next.` alias — a redirect target is an exfiltration route for
        // an authorization code, and the list is the only thing standing
        // in front of it.
        callbackUrls: [AUTH_CALLBACK_URL],
        logoutUrls: [AUTH_SIGN_OUT_URL],
      },
      // No social/federated providers — this is a clinical directory.
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: ACCESS_TOKEN_VALIDITY,
      idTokenValidity: ID_TOKEN_VALIDITY,
      refreshTokenValidity: REFRESH_TOKEN_VALIDITY,
      // Makes `RevokeToken` work at all, which is what 2.2.4's sign-out
      // and 2.4.1's deactivation both call.
      enableTokenRevocation: true,
      // A sign-in error must not tell an unauthenticated caller whether an
      // address is registered here. On a clinic's patient directory, that
      // fact is itself disclosure.
      preventUserExistenceErrors: true,
      readAttributes: CLIENT_READ_ATTRIBUTES,
      writeAttributes: CLIENT_WRITE_ATTRIBUTES,
    });
  }

  private exportIdentifiers(role: string, pool: UserPool, client: UserPoolClient): void {
    new CfnOutput(this, `${role}UserPoolId`, {
      value: pool.userPoolId,
      description: `${role} pool id — record in infra/src/config.ts (TASK 2.2.1 step 8).`,
    });
    new CfnOutput(this, `${role}UserPoolClientId`, {
      value: client.userPoolClientId,
      description: `${role} app client id — record in infra/src/config.ts (TASK 2.2.1 step 8).`,
    });
    new CfnOutput(this, `${role}UserPoolIssuerUrl`, {
      value: pool.userPoolProviderUrl,
      description: `${role} pool issuer — one of the two 2.2.2 verifies \`iss\` against.`,
    });
  }
}
