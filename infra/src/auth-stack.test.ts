// Same philosophy as data-stack.test.ts/guardrails.test.ts: CDK's
// assertions library synthesizes the exact CloudFormation template AWS
// would receive, with zero live AWS calls. The real-AWS half of this
// task's proof (`describe-user-pool` against the deployed pools, and the
// policy simulator against the real `ndn-deploy` role) is in
// docs/runbooks/cognito-user-pools.md and CI's oidc-dry-run job.

import { App, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { AuthStack } from './auth-stack.js';
import {
  CLINICIAN_USER_POOL_CLIENT_ID,
  CLINICIAN_USER_POOL_ID,
  CLINICIAN_USER_POOL_ISSUER,
  CLINICIAN_USER_POOL_NAME,
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
  PATIENT_USER_POOL_CLIENT_ID,
  PATIENT_USER_POOL_ID,
  PATIENT_USER_POOL_ISSUER,
  PATIENT_USER_POOL_NAME,
  REGION,
  SITE_ORIGIN,
} from './config.js';

// No Lambdas in this stack, so synth is cheap — memoized anyway for the
// same reason its siblings are: a Template is only ever read.
let template: Template | undefined;

function synth(): Template {
  return (template ??= (() => {
    const app = new App();
    const stack = new AuthStack(app, 'TestAuthStack', {
      env: { account: '357601815388', region: 'eu-west-2' },
    });
    return Template.fromStack(stack);
  })());
}

// Only the properties these tests assert on. Written out rather than
// reached for through `any`, so a CDK upgrade that renames one fails the
// typecheck instead of quietly turning an assertion into `undefined ===
// undefined`.
interface UserPoolResource {
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: {
    UserPoolName?: string;
    UserPoolTier?: string;
    UserPoolAddOns?: unknown;
    DeletionProtection?: string;
    MfaConfiguration?: string;
    EnabledMfas?: string[];
    SmsConfiguration?: unknown;
    Policies?: { SignInPolicy?: unknown; PasswordPolicy?: unknown };
    AdminCreateUserConfig?: unknown;
    Schema?: { Name: string; Required?: boolean; Mutable?: boolean }[];
    AccountRecoverySetting?: { RecoveryMechanisms?: unknown };
    UsernameAttributes?: string[];
    LambdaConfig?: unknown;
  };
}

interface UserPoolClientProperties {
  ClientName?: string;
  GenerateSecret?: boolean;
  AllowedOAuthFlowsUserPoolClient?: boolean;
  AllowedOAuthFlows?: string[];
  AllowedOAuthScopes?: string[];
  SupportedIdentityProviders?: string[];
  CallbackURLs?: string[];
  LogoutURLs?: string[];
  ExplicitAuthFlows?: string[];
  AccessTokenValidity?: number;
  IdTokenValidity?: number;
  RefreshTokenValidity?: number;
  TokenValidityUnits?: unknown;
  EnableTokenRevocation?: boolean;
  PreventUserExistenceErrors?: string;
  ReadAttributes?: string[];
  WriteAttributes?: string[];
}

function poolNamed(name: string): UserPoolResource {
  const pools = Object.values(
    synth().findResources('AWS::Cognito::UserPool'),
  ) as UserPoolResource[];
  const match = pools.find((pool) => pool.Properties.UserPoolName === name);
  expect(match, `no user pool named ${name}`).toBeDefined();
  return match!;
}

function poolProperties(name: string): UserPoolResource['Properties'] {
  return poolNamed(name).Properties;
}

function clientNamed(name: string): UserPoolClientProperties {
  const clients = Object.values(
    synth().findResources('AWS::Cognito::UserPoolClient'),
  ) as { Properties: UserPoolClientProperties }[];
  const match = clients.find((client) => client.Properties.ClientName === name);
  expect(match, `no app client named ${name}`).toBeDefined();
  return match!.Properties;
}

const POOL_NAMES = [PATIENT_USER_POOL_NAME, CLINICIAN_USER_POOL_NAME];
const CLIENT_NAMES = [`${PATIENT_USER_POOL_NAME}-web`, `${CLINICIAN_USER_POOL_NAME}-web`];
const CLINICIAN_ADMIN_AUTH_CLIENT_NAME = `${CLINICIAN_USER_POOL_NAME}-admin-auth`;

describe('AuthStack — the pools exist and cannot be deleted', () => {
  it('creates exactly two pools and three app clients, no more', () => {
    synth().resourceCountIs('AWS::Cognito::UserPool', 2);
    // Three, not two, since D-30: the two browser clients (unchanged) plus
    // the clinician-only admin-auth client this stack's own D-30 section
    // adds — asserted individually below, this is only the total count.
    synth().resourceCountIs('AWS::Cognito::UserPoolClient', 3);
  });

  it.each(POOL_NAMES)('%s has deletion protection ACTIVE and is retained', (name) => {
    const pool = poolNamed(name);
    expect(poolProperties(name).DeletionProtection).toBe('ACTIVE');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  it.each(POOL_NAMES)('%s is on the Essentials tier with no paid threat protection', (name) => {
    const properties = poolProperties(name);
    expect(properties.UserPoolTier).toBe('ESSENTIALS');
    // £0 buys the directory and the MFA, not the risk engine (step 7).
    expect(properties.UserPoolAddOns).toBeUndefined();
  });
});

describe('AuthStack — the two policies one pool could not hold', () => {
  // Amendment, 2026-08-31: `ON` (mandatory) relaxed to `OPTIONAL` — the
  // owner's own call, auth-stack.ts's own header on `mfa:` below has the
  // full reasoning. TOTP is still the only *offered* factor when a
  // clinician does enrol one; it is no longer forced on every clinician.
  it('offers TOTP and only TOTP on the clinician pool, without forcing it', () => {
    const properties = poolProperties(CLINICIAN_USER_POOL_NAME);
    expect(properties.MfaConfiguration).toBe('OPTIONAL');
    expect(properties.EnabledMfas).toEqual(['SOFTWARE_TOKEN_MFA']);
    // R-02: SMS is a spendable path, and a phone-number factor is a poorer
    // one. Asserted as an absence, not just a non-selection.
    expect(properties.EnabledMfas).not.toContain('SMS_MFA');
    expect(properties.SmsConfiguration).toBeUndefined();
  });

  it('asks a patient for no second factor at all', () => {
    const properties = poolProperties(PATIENT_USER_POOL_NAME);
    expect(properties.MfaConfiguration).toBe('OFF');
    expect(properties.EnabledMfas).toBeUndefined();
  });

  it('D-29: neither pool offers a first factor beyond a plain password', () => {
    // The patient pool carries an *explicit* password-only policy, not an
    // omitted one — found live, 2026-08-29 (auth-stack.ts's own comment on
    // the pool construction): `UpdateUserPool` left a previously-set
    // `EMAIL_OTP` allowance stale when the field was merely removed from
    // the template, so only an explicit narrower value actually clears it.
    // The clinician pool has never had one to leave stale, so Cognito's
    // own omitted-field default (password-only) genuinely holds there.
    expect(poolProperties(PATIENT_USER_POOL_NAME).Policies?.SignInPolicy).toEqual({
      AllowedFirstAuthFactors: ['PASSWORD'],
    });
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).Policies?.SignInPolicy).toBeUndefined();
  });

  it('D-29: creates both accounts by admin action only — self sign-up is off for both pools', () => {
    // AllowAdminCreateUserOnly is the inverse of selfSignUpEnabled: `true`
    // means only an admin action creates a user. TASK 2.4.1's clinician
    // directory has always worked this way; D-29 (2026-08-29) brings the
    // patient pool onto the identical model — see auth-stack.ts's header.
    expect(poolProperties(PATIENT_USER_POOL_NAME).AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: true,
    });
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: true,
    });
  });

  it('D-29: gives both pools the identical password policy', () => {
    const expectedPolicy = {
      MinimumLength: 8,
      RequireLowercase: true,
      RequireUppercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
    };
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).Policies?.PasswordPolicy).toEqual(
      expectedPolicy,
    );
    expect(poolProperties(PATIENT_USER_POOL_NAME).Policies?.PasswordPolicy).toEqual(
      expectedPolicy,
    );
  });

  it.each(POOL_NAMES)('D-29: %s carries no Lambda trigger of any kind', (name) => {
    // TASK 2.2.3's Post-Confirmation trigger — the only trigger either
    // pool ever carried — is deleted outright, not merely unwired
    // (auth-stack.ts's own header amendment): with self sign-up off on
    // both pools, no `ConfirmSignUp` event exists for one to react to.
    expect(poolProperties(name).LambdaConfig).toBeUndefined();
  });

  it('D-29: the patient pool recovers by admin only — email-based recovery is off', () => {
    // `ForgotPassword` is unauthenticated and independent of the app
    // client's own `ExplicitAuthFlows` — see auth-stack.ts's own D-29
    // amendment for why leaving `EMAIL_ONLY` in place would have been a
    // real hole in the WhatsApp-verified reset model.
    expect(poolProperties(PATIENT_USER_POOL_NAME).AccountRecoverySetting?.RecoveryMechanisms).toEqual([
      { Name: 'admin_only', Priority: 1 },
    ]);
    // Unchanged for the clinician pool — nothing about D-29 touches it.
    expect(
      poolProperties(CLINICIAN_USER_POOL_NAME).AccountRecoverySetting?.RecoveryMechanisms,
    ).toEqual([{ Name: 'verified_email', Priority: 1 }]);
  });
});

describe('AuthStack — no personal data in the directory', () => {
  it.each(POOL_NAMES)('%s carries a required, mutable email and nothing else', (name) => {
    const properties = poolProperties(name);
    expect(properties.Schema).toEqual([{ Name: 'email', Required: true, Mutable: true }]);
    expect(properties.UsernameAttributes).toEqual(['email']);
    // Which recovery mechanism (if any) each pool's own account-recovery
    // setting resolves to is D-29's own dedicated test above — the two
    // pools deliberately differ here, so it does not belong in this
    // identical-for-both-pools block.
  });

  it.each(POOL_NAMES)('%s has no custom attribute of any kind', (name) => {
    const schema = poolProperties(name).Schema ?? [];
    expect(schema.filter((attribute) => attribute.Name.startsWith('custom:'))).toEqual([]);
  });

  it.each(CLIENT_NAMES)('%s can read and write no attribute but the address', (name) => {
    const properties = clientNamed(name);
    expect(properties.ReadAttributes).toEqual(['email', 'email_verified']);
    expect(properties.WriteAttributes).toEqual(['email']);
  });
});

describe('AuthStack — the browser clients', () => {
  it.each(CLIENT_NAMES)('%s holds no client secret', (name) => {
    // The enforceable half of "PKCE required": a public client's code
    // exchange is unauthenticated, so PKCE is the only thing binding the
    // code to the requester. Cognito has no server-side switch that
    // rejects an exchange without a code_verifier — 2.2.4's own code is
    // what must send code_challenge.
    expect(clientNamed(name).GenerateSecret).toBe(false);
  });

  it.each(CLIENT_NAMES)('%s uses the authorization code grant and no other', (name) => {
    const properties = clientNamed(name);
    expect(properties.AllowedOAuthFlows).toEqual(['code']);
    expect(properties.AllowedOAuthFlows).not.toContain('implicit');
    expect(properties.SupportedIdentityProviders).toEqual(['COGNITO']);
  });

  // D-34 (2026-08-31): the two clients deliberately differ here now —
  // found live, `ChangePassword` refuses any access token without
  // `aws.cognito.signin.user.admin`, so the clinician client carries it
  // and the patient one, with no self-service credential action of any
  // kind (D-29), stays exactly `openid email`. auth-stack.ts's own
  // `extraScopes` header on the clinician client has the full story.
  it(`${PATIENT_USER_POOL_NAME}-web requests only openid and email`, () => {
    expect(clientNamed(`${PATIENT_USER_POOL_NAME}-web`).AllowedOAuthScopes).toEqual([
      'openid',
      'email',
    ]);
  });

  it(`${CLINICIAN_USER_POOL_NAME}-web also requests the admin scope ChangePassword needs`, () => {
    expect(clientNamed(`${CLINICIAN_USER_POOL_NAME}-web`).AllowedOAuthScopes).toEqual([
      'openid',
      'email',
      'aws.cognito.signin.user.admin',
    ]);
  });

  it.each(CLIENT_NAMES)('%s redirects to no host other than SITE_ORIGIN', (name) => {
    const properties = clientNamed(name);
    const urls = [...(properties.CallbackURLs ?? []), ...(properties.LogoutURLs ?? [])];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).origin).toBe(SITE_ORIGIN);
    }
  });

  it('D-29: gives both clients the identical SRP auth flow — neither is ever handed a plaintext password', () => {
    const patient = clientNamed(`${PATIENT_USER_POOL_NAME}-web`);
    const clinician = clientNamed(`${CLINICIAN_USER_POOL_NAME}-web`);
    expect(patient.ExplicitAuthFlows).toEqual(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
    expect(clinician.ExplicitAuthFlows).toEqual(['ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
    for (const properties of [patient, clinician]) {
      expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
      expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
      expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_CUSTOM_AUTH');
    }
  });

  it.each(CLIENT_NAMES)('%s issues 60-minute tokens on a 30-day refresh, revocably', (name) => {
    const properties = clientNamed(name);
    expect(properties.AccessTokenValidity).toBe(60);
    expect(properties.IdTokenValidity).toBe(60);
    // Minutes, per TokenValidityUnits: 30 days.
    expect(properties.RefreshTokenValidity).toBe(30 * 24 * 60);
    expect(properties.TokenValidityUnits).toEqual({
      AccessToken: 'minutes',
      IdToken: 'minutes',
      RefreshToken: 'minutes',
    });
    // What makes 2.2.4's sign-out and 2.4.1's deactivation immediate.
    expect(properties.EnableTokenRevocation).toBe(true);
    // A sign-in error must not disclose whether an address is registered
    // at a neuro-rehab clinic.
    expect(properties.PreventUserExistenceErrors).toBe('ENABLED');
  });
});

describe('AuthStack — D-30: the clinician admin-auth client, and the boundary it must not cross', () => {
  it('exists on the clinician pool alone, with ALLOW_ADMIN_USER_PASSWORD_AUTH and nothing else', () => {
    const properties = clientNamed(CLINICIAN_ADMIN_AUTH_CLIENT_NAME);
    expect(properties.ExplicitAuthFlows).toEqual([
      'ALLOW_ADMIN_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ]);
    expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_SRP_AUTH');
    expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_USER_PASSWORD_AUTH');
    expect(properties.ExplicitAuthFlows).not.toContain('ALLOW_CUSTOM_AUTH');
  });

  it('holds no client secret and no OAuth configuration — never a redirect-based sign-in', () => {
    const properties = clientNamed(CLINICIAN_ADMIN_AUTH_CLIENT_NAME);
    expect(properties.GenerateSecret).toBe(false);
    // The property whose absence caused a real live deploy failure
    // (`disableOAuth: true` vs. an all-flows-false `oAuth` block, this
    // file's own header comment) — asserted directly so a regression to
    // the broken shape fails here, at synth, rather than at a real
    // CreateUserPoolClient call again.
    expect(properties.AllowedOAuthFlowsUserPoolClient).toBe(false);
    expect(properties.AllowedOAuthFlows).toBeUndefined();
    expect(properties.AllowedOAuthScopes).toBeUndefined();
    expect(properties.CallbackURLs).toBeUndefined();
    expect(properties.LogoutURLs).toBeUndefined();
  });

  it('does not exist on the patient pool — clinician-only, per D-30', () => {
    const clients = Object.values(
      synth().findResources('AWS::Cognito::UserPoolClient'),
    ) as { Properties: UserPoolClientProperties }[];
    const names = clients.map((client) => client.Properties.ClientName);
    expect(names).toContain(CLINICIAN_ADMIN_AUTH_CLIENT_NAME);
    expect(names).not.toContain(`${PATIENT_USER_POOL_NAME}-admin-auth`);
  });

  it("leaves the browser client's own flows exactly as D-29's own test already proved — the boundary this client exists to preserve", () => {
    const browserClinician = clientNamed(`${CLINICIAN_USER_POOL_NAME}-web`);
    expect(browserClinician.ExplicitAuthFlows).toEqual([
      'ALLOW_USER_SRP_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ]);
    expect(browserClinician.ExplicitAuthFlows).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
  });
});

describe('AuthStack — exported identifiers', () => {
  it('outputs both pool ids, both client ids, both issuer URLs, and D-30s admin-auth client id', () => {
    const outputs = synth().findOutputs('*');
    expect(Object.keys(outputs).sort()).toEqual([
      'ClinicianAdminAuthClientId',
      'ClinicianLoginCloudFrontDomain',
      'ClinicianUserPoolClientId',
      'ClinicianUserPoolId',
      'ClinicianUserPoolIssuerUrl',
      'PatientLoginCloudFrontDomain',
      'PatientUserPoolClientId',
      'PatientUserPoolId',
      'PatientUserPoolIssuerUrl',
    ]);
  });

  it('takes the app-wide cost allocation tag, which Cognito shapes as a map', () => {
    // tagging.test.ts proves `Tags.of(app)` reaches an ordinary resource;
    // this proves it reaches *this* one, whose CloudFormation property is
    // `UserPoolTags` (a key/value object) rather than the `Tags` array
    // every other taggable resource in the estate uses. A different shape
    // is a different chance to be silently untagged, and untagged spend is
    // spend C-01's £20 cap cannot see.
    const app = new App();
    Tags.of(app).add(COST_ALLOCATION_TAG_KEY, COST_ALLOCATION_TAG_VALUE);
    const stack = new AuthStack(app, 'TestTaggedAuthStack', {
      env: { account: '357601815388', region: 'eu-west-2' },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: { [COST_ALLOCATION_TAG_KEY]: COST_ALLOCATION_TAG_VALUE },
    });
  });
});

// The four identifiers `NdnAuthStack` generated on its first deploy
// (2026-08-22) and config.ts now carries. Nothing here synthesizes — these
// assertions guard a hand-copied value, which is the only part of TASK
// 2.2.1 a human typed rather than a machine emitted.
//
// The two issuer strings are the deploy's own CloudFormation output,
// checked in the same spirit as the guardrail fixture: config.ts *derives*
// its issuers from the pool ids, so a mistyped pool id fails here rather
// than at 2.2.2's first token verification, where the symptom would be
// every sign-in failing with a signature error.
describe('the recorded pool identifiers', () => {
  const DEPLOYED_ISSUERS = {
    patient: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_lMonWXA0b',
    clinician: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_1SFN2y0Jt',
  };

  it('derives issuers that match what the deploy actually reported', () => {
    expect(PATIENT_USER_POOL_ISSUER).toBe(DEPLOYED_ISSUERS.patient);
    expect(CLINICIAN_USER_POOL_ISSUER).toBe(DEPLOYED_ISSUERS.clinician);
  });

  it('holds two distinct pools and two distinct clients', () => {
    // A copy-paste that pointed both roles at one directory would undo the
    // entire reason there are two.
    expect(PATIENT_USER_POOL_ID).not.toBe(CLINICIAN_USER_POOL_ID);
    expect(PATIENT_USER_POOL_CLIENT_ID).not.toBe(CLINICIAN_USER_POOL_CLIENT_ID);
  });

  it('has pool ids in this region and client ids in Cognito\'s own shape', () => {
    for (const id of [PATIENT_USER_POOL_ID, CLINICIAN_USER_POOL_ID]) {
      expect(id).toMatch(new RegExp(`^${REGION}_[A-Za-z0-9]+$`));
    }
    // Cognito app client ids are 26 lowercase base-32 characters; a pool id
    // pasted into a client slot fails this, and vice versa.
    for (const id of [PATIENT_USER_POOL_CLIENT_ID, CLINICIAN_USER_POOL_CLIENT_ID]) {
      expect(id).toMatch(/^[a-z0-9]{26}$/);
    }
  });
});

// D-29 (2026-08-29): TASK 2.2.3's Post-Confirmation trigger, once tested
// here, is deleted along with self sign-up — see auth-stack.ts's own
// header amendment. Neither pool carries a `LambdaConfig` any more; the
// existing "still synthesizes" shape is now simply how both pools
// synthesize, unconditionally, which is covered by every `poolProperties`
// call above rather than needing its own block.

// Found live, 2026-08-27: `NEWER_MANAGED_LOGIN` (above) renders no login
// page at all — Cognito returns 403 "Login pages unavailable" — until a
// branding style is explicitly assigned to the app client. Nothing here
// asserted that until now, which is exactly how it went unnoticed since
// this stack's first deploy.
describe('AuthStack — managed login branding (found missing live, 2026-08-27)', () => {
  interface ManagedLoginBrandingResource {
    Properties: {
      UserPoolId: unknown;
      ClientId: unknown;
      UseCognitoProvidedValues?: boolean;
      Settings?: unknown;
      Assets?: ReadonlyArray<{ Category: string; ColorMode: string; Extension: string }>;
    };
  }

  function brandings(): ManagedLoginBrandingResource[] {
    return Object.values(
      synth().findResources('AWS::Cognito::ManagedLoginBranding'),
    ) as ManagedLoginBrandingResource[];
  }

  it('assigns a branding style to both app clients, not just the domain', () => {
    expect(brandings()).toHaveLength(2);
  });

  // Amendment, 2026-08-30: `useCognitoProvidedValues: true` is gone —
  // confirmed live, it accepts a custom `assets` array without error but
  // never renders it, so a favicon needed the switch to an explicit
  // `settings` object (captured verbatim from Cognito's own defaults,
  // `managed-login-branding-settings.json`) instead.
  it('supplies real settings rather than an unset, broken style', () => {
    for (const branding of brandings()) {
      expect(branding.Properties.UseCognitoProvidedValues).toBeUndefined();
      expect(branding.Properties.Settings).toBeTruthy();
    }
  });

  it('carries a favicon for both light and dark mode, ICO and SVG', () => {
    for (const branding of brandings()) {
      const categories = (branding.Properties.Assets ?? []).map(
        (asset) => `${asset.Category}:${asset.ColorMode}`,
      );
      expect(categories.sort()).toEqual(
        ['FAVICON_ICO:DARK', 'FAVICON_ICO:LIGHT', 'FAVICON_SVG:DARK', 'FAVICON_SVG:LIGHT'].sort(),
      );
    }
  });
});
