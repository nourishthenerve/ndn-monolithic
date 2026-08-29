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
//
// ## Amendment, D-29 (2026-08-29) — the patient pool reverts to a
// password, and self sign-up is retired
//
// TASK 2.2.3's own patient pool config — `selfSignUpEnabled: true`,
// passwordless email-OTP as the only reachable first factor — is gone.
// The owner's own decision (D-29, `docs/plan/01-decisions.md`): a patient
// never registers themselves. They contact the clinic's WhatsApp Business
// number, a human verifies who they are and creates the account on their
// behalf (`services/api/src/patient-admin.ts`), setting a permanent
// password the patient does not choose. Forgetting it is the same
// WhatsApp conversation again, never a self-service reset.
//
// What changes here, concretely: `selfSignUpEnabled: false` (matching the
// clinician pool's own "admin action creates a user" model exactly); an
// explicit, narrowed `signInPolicy` (`AllowedFirstAuthFactors: [PASSWORD]`
// — **not simply removed**, see the live finding on the pool construction
// below: `UpdateUserPool` does not clear a previously-set `SignInPolicy`
// on omission, so the first deploy of this amendment left `EMAIL_OTP`
// stale at the pool level despite the template showing no policy at all);
// a `passwordPolicy`, identical to the clinician pool's;
// `accountRecovery: AccountRecovery.NONE`, the one setting this amendment
// could not skip — `ForgotPassword`/`ConfirmForgotPassword` are
// unauthenticated, un-IAM-gated Cognito APIs, independent of which
// `ExplicitAuthFlows` an app client carries, so leaving `EMAIL_ONLY` in
// place would have let anyone who knew or guessed a patient's email
// self-serve a password reset entirely outside the WhatsApp-verified
// process this whole design exists to enforce. The web client's
// `authFlows` move from `{ user: true }` (choice-based, the only flow that
// can present an `EMAIL_OTP` challenge) to `{ userSrp: true }` — the
// clinician pool's own flow, proving a password rather than transmitting
// one. The Post-Confirmation trigger this pool used to carry
// (`post-confirmation.ts`, TASK 2.2.3) is deleted outright, not merely
// unwired: with self sign-up off, `ConfirmSignUp` can never fire, so the
// trigger had no event left to react to.
//
// The email attribute stays exactly as TASK 2.2.1 built it — required,
// mutable, the pool's only attribute. It carries no functional weight any
// more (no OTP is ever sent to it, and `AccountRecovery.NONE` means
// nothing recovers through it either), but changing a pool's required
// attributes needs recreating the pool, which this amendment has no
// reason to force. Staff still collect an address during WhatsApp intake
// and it is still set on the Cognito user, unverified in any real sense —
// see `patient-admin-handler.ts`'s own header for why `email_verified` is
// still set `true` regardless.

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  ClientAttributes,
  FeaturePlan,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  ManagedLoginVersion,
  type UserPoolProps,
} from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';

import {
  AUTH_CALLBACK_URL,
  AUTH_SIGN_OUT_URL,
  CLINICIAN_USER_POOL_DOMAIN_PREFIX,
  CLINICIAN_USER_POOL_NAME,
  PATIENT_USER_POOL_DOMAIN_PREFIX,
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
// address itself — `patient-admin.ts`'s `AdminCreateUser` call sets the
// patient's, `clinician-admin.ts`'s sets the clinician's.
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

// TASK 2.2.3 gave this stack a `postConfirmationFunction` prop, attaching
// `NdnDataStack`'s Post-Confirmation trigger to the patient pool. Deleted
// by D-29 (2026-08-29), not merely made optional-and-unused: with self
// sign-up off, no `ConfirmSignUp` event can ever fire, so there is nothing
// left for a trigger to react to — see this file's own header amendment.
export type AuthStackProps = StackProps;

export class AuthStack extends Stack {
  public readonly patientUserPool: UserPool;
  public readonly clinicianUserPool: UserPool;
  public readonly patientUserPoolClient: UserPoolClient;
  public readonly clinicianUserPoolClient: UserPoolClient;
  public readonly patientUserPoolDomain: UserPoolDomain;
  public readonly clinicianUserPoolDomain: UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps = {}) {
    super(scope, id, props);

    this.patientUserPool = new UserPool(this, 'PatientUserPool', {
      ...SHARED_POOL_PROPS,
      userPoolName: PATIENT_USER_POOL_NAME,
      // D-29 (2026-08-29): a patient account is created by a principal via
      // `patient-admin.ts`, never by the patient themselves — the same
      // "admin action creates a user" model the clinician pool has always
      // used. Approval (a clinician moving `pending` to `approved`) stays
      // a state on the DynamoDB record, unaffected by this change — see
      // this file's own header amendment.
      selfSignUpEnabled: false,
      // **An explicit `signInPolicy`, not an omitted one — found live,
      // 2026-08-29, the first deploy of this amendment.** The clinician
      // pool has never carried a `SignInPolicy` at all, so "omit it, get
      // Cognito's password-only default" holds there. This pool is
      // different: TASK 2.2.1 explicitly *set* `AllowedFirstAuthFactors:
      // [PASSWORD, EMAIL_OTP]` on it, and `UpdateUserPool` does not clear
      // a previously-set `Policies.SignInPolicy` when the field is simply
      // absent from a later update's `Policies` object — confirmed
      // directly: `PasswordPolicy` (added the same deploy, in the same
      // `Policies` object) applied correctly, while `SignInPolicy` stayed
      // exactly as `EMAIL_OTP`-inclusive as it was before, even though
      // CloudFormation's own template — and this file's own git history —
      // both show the field simply removed. An omission is not a clear;
      // only an explicit narrower value is. Harmless in practice today
      // (the client's own `ExplicitAuthFlows`, just below, no longer
      // offers `ALLOW_USER_AUTH`, so nothing can reach `EMAIL_OTP` through
      // the one client that exists — the identical "the client is the
      // real boundary" property this file already relied on for the
      // *original* `[PASSWORD, EMAIL_OTP]` policy), but a dormant,
      // undocumented pool-level allowance one future app client with
      // `ALLOW_USER_AUTH` would silently reactivate. Closed at the source
      // instead of left resting on the client alone.
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true,
          emailOtp: false,
          smsOtp: false,
          passkey: false,
        },
      },
      mfa: Mfa.OFF,
      // Matches the clinician pool's own policy exactly — CDK's defaults,
      // written out so they are visible in the synthesized template and
      // assertable in a test rather than inherited silently. There is no
      // reason for the two pools' password strength to differ, and every
      // patient password is machine-generated (`password-generator.ts`)
      // to satisfy it, never typed in by a person choosing their own.
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // The one setting this amendment could not leave at
      // `SHARED_POOL_PROPS`'s own `EMAIL_ONLY` default. `ForgotPassword`/
      // `ConfirmForgotPassword` are unauthenticated Cognito APIs,
      // independent of the app client's own `ExplicitAuthFlows` — leaving
      // email-based recovery enabled would let anyone who knew or guessed
      // a patient's address self-serve a password reset entirely outside
      // the WhatsApp-verified process this design exists to enforce.
      // `NONE` is Cognito's own name for exactly this model: "users will
      // have to contact an administrator to reset their passwords."
      accountRecovery: AccountRecovery.NONE,
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
      // D-29: SRP, not `ALLOW_USER_PASSWORD_AUTH` — the same reasoning the
      // clinician client below has always used. The password is proved
      // rather than transmitted; unlike the clinician pool, no MFA
      // challenge follows.
      authFlows: { userSrp: true },
    });

    this.clinicianUserPoolClient = this.addWebClient('ClinicianUserPoolClient', {
      userPool: this.clinicianUserPool,
      clientName: `${CLINICIAN_USER_POOL_NAME}-web`,
      // SRP, not `ALLOW_USER_PASSWORD_AUTH`: the password is proved rather
      // than transmitted. Cognito follows it with the
      // `SOFTWARE_TOKEN_MFA` challenge the pool requires.
      authFlows: { userSrp: true },
    });

    // TASK 2.2.4: the hosted sign-in pages and, more importantly, the
    // `/oauth2/*` endpoints — `authorize`, `token` and `revoke` all live on
    // this domain and none of them exists without it. TASK 2.2.1
    // deliberately left it out ("2.2.4 decides whether it needs the hosted
    // UI at all"); the answer is yes, because the authorization-code flow
    // is what keeps a refresh token out of the browser entirely.
    //
    // `NEWER_MANAGED_LOGIN` rather than the classic hosted UI: TASK 2.2.1
    // chose it for the passwordless email-OTP pages D-29 has since
    // retired, but it costs nothing to keep — both versions are free at
    // the Essentials tier, and a second hosted-UI migration has nothing
    // this amendment needs it for.
    //
    // A Cognito-prefix domain rather than a custom one: a custom domain
    // needs its own ACM certificate in `us-east-1` and a DNS record in a
    // hosted zone that lives in another account
    // (docs/runbooks/iac-baseline.md), which is a manual cross-account step
    // for cosmetics. The prefix is visible to the patient for the seconds
    // they are on the sign-in page.
    this.patientUserPoolDomain = new UserPoolDomain(this, 'PatientUserPoolDomain', {
      userPool: this.patientUserPool,
      cognitoDomain: { domainPrefix: PATIENT_USER_POOL_DOMAIN_PREFIX },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    this.clinicianUserPoolDomain = new UserPoolDomain(this, 'ClinicianUserPoolDomain', {
      userPool: this.clinicianUserPool,
      cognitoDomain: { domainPrefix: CLINICIAN_USER_POOL_DOMAIN_PREFIX },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Found live, 2026-08-27, the first real sign-in attempt against
    // either pool: `NEWER_MANAGED_LOGIN` (above) renders nothing at all —
    // Cognito returns "Login pages unavailable. Please contact an
    // administrator." (403) — until a branding style is explicitly
    // assigned to the app client. This is not optional configuration on
    // top of a working page; without it, the page does not exist. AWS's
    // own default branding is enough (`useCognitoProvidedValues: true`) —
    // this stack has no custom visual identity to apply, only a working
    // login page to have at all.
    new CfnManagedLoginBranding(this, 'PatientManagedLoginBranding', {
      userPoolId: this.patientUserPool.userPoolId,
      clientId: this.patientUserPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    new CfnManagedLoginBranding(this, 'ClinicianManagedLoginBranding', {
      userPoolId: this.clinicianUserPool.userPoolId,
      clientId: this.clinicianUserPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
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
