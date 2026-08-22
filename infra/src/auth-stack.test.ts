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
  CLINICIAN_USER_POOL_NAME,
  COST_ALLOCATION_TAG_KEY,
  COST_ALLOCATION_TAG_VALUE,
  PATIENT_USER_POOL_NAME,
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
  };
}

interface UserPoolClientProperties {
  ClientName?: string;
  GenerateSecret?: boolean;
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

describe('AuthStack — the pools exist and cannot be deleted', () => {
  it('creates exactly two pools and two app clients, no more', () => {
    synth().resourceCountIs('AWS::Cognito::UserPool', 2);
    synth().resourceCountIs('AWS::Cognito::UserPoolClient', 2);
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
  it('requires TOTP and only TOTP on the clinician pool', () => {
    const properties = poolProperties(CLINICIAN_USER_POOL_NAME);
    expect(properties.MfaConfiguration).toBe('ON');
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

  it('offers email OTP as a first factor to patients and not to clinicians', () => {
    // PASSWORD is present because Cognito requires it in the list — see
    // auth-stack.ts's note. What matters is that EMAIL_OTP is offered here
    // and that the clinician pool has no SignInPolicy at all, so its
    // default (password only) stands and there is no way past the TOTP
    // requirement above.
    expect(poolProperties(PATIENT_USER_POOL_NAME).Policies?.SignInPolicy).toEqual({
      AllowedFirstAuthFactors: ['PASSWORD', 'EMAIL_OTP'],
    });
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).Policies?.SignInPolicy).toBeUndefined();
  });

  it('lets patients register themselves and never lets a clinician', () => {
    // AllowAdminCreateUserOnly is the inverse of selfSignUpEnabled: `true`
    // means only an admin action creates a user, which is 2.4.1's whole
    // model for the clinician directory.
    expect(poolProperties(PATIENT_USER_POOL_NAME).AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: false,
    });
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).AdminCreateUserConfig).toEqual({
      AllowAdminCreateUserOnly: true,
    });
  });

  it('gives the clinician pool a password policy and the patient pool none to need', () => {
    expect(poolProperties(CLINICIAN_USER_POOL_NAME).Policies?.PasswordPolicy).toEqual({
      MinimumLength: 8,
      RequireLowercase: true,
      RequireUppercase: true,
      RequireNumbers: true,
      RequireSymbols: true,
    });
    expect(poolProperties(PATIENT_USER_POOL_NAME).Policies?.PasswordPolicy).toBeUndefined();
  });
});

describe('AuthStack — no personal data in the directory', () => {
  it.each(POOL_NAMES)('%s carries a required, mutable email and nothing else', (name) => {
    const properties = poolProperties(name);
    expect(properties.Schema).toEqual([{ Name: 'email', Required: true, Mutable: true }]);
    // Recovery by email only: no phone number to recover through, because
    // there is no phone number.
    expect(properties.AccountRecoverySetting?.RecoveryMechanisms).toEqual([
      { Name: 'verified_email', Priority: 1 },
    ]);
    expect(properties.UsernameAttributes).toEqual(['email']);
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
    expect(properties.AllowedOAuthScopes).toEqual(['openid', 'email']);
    expect(properties.SupportedIdentityProviders).toEqual(['COGNITO']);
  });

  it.each(CLIENT_NAMES)('%s redirects to no host other than SITE_ORIGIN', (name) => {
    const properties = clientNamed(name);
    const urls = [...(properties.CallbackURLs ?? []), ...(properties.LogoutURLs ?? [])];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(new URL(url).origin).toBe(SITE_ORIGIN);
    }
  });

  it('gives each client only the auth flow its own users need', () => {
    // A patient has no password path through the only client that exists;
    // a clinician's password is proved by SRP rather than transmitted.
    // Neither client can ever be handed a plaintext password.
    const patient = clientNamed(`${PATIENT_USER_POOL_NAME}-web`);
    const clinician = clientNamed(`${CLINICIAN_USER_POOL_NAME}-web`);
    expect(patient.ExplicitAuthFlows).toEqual(['ALLOW_USER_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH']);
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

describe('AuthStack — exported identifiers', () => {
  it('outputs both pool ids, both client ids and both issuer URLs', () => {
    const outputs = synth().findOutputs('*');
    expect(Object.keys(outputs).sort()).toEqual([
      'ClinicianUserPoolClientId',
      'ClinicianUserPoolId',
      'ClinicianUserPoolIssuerUrl',
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
