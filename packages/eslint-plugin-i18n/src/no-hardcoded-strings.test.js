import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

import rule from './no-hardcoded-strings.js';

// espree (ESLint's default parser) parses JSX when told to via
// parserOptions.ecmaFeatures.jsx — no @typescript-eslint/parser or real
// Astro tooling needed here. astro-eslint-parser documents that it
// produces this exact JSX-compatible AST (JSXText/JSXExpressionContainer/
// JSXAttribute) for an .astro file's template, so exercising the rule
// against plain JSX is a high-fidelity proxy for both .tsx and .astro
// output, without spinning up the Astro compiler in a unit test.
const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('ndnI18n/no-hardcoded-strings', () => {
  it('accepts t()-wrapped output and non-content literals', () => {
    ruleTester.run('no-hardcoded-strings', rule, {
      valid: [
        // Children wrapped by t().
        "const el = <button>{t('common.send')}</button>;",
        // A variable/expression child (e.g. a brand name from config) is not copy this rule can see.
        'const el = <title>{siteName}</title>;',
        // Content attribute wrapped by t().
        "const el = <Input label={t('home.emailLabel')} />;",
        // A content attribute with no value at all (JSX boolean/shorthand form).
        'const el = <Input label />;',
        // Structural attributes are out of scope even though their values contain letters.
        'const el = <input type="email" name="email" autoComplete="email" />;',
        'const el = <a href="/about" className="ndn-link" id="main" rel="noopener noreferrer" />;',
        // Whitespace-only JSXText between elements (ordinary JSX formatting).
        'const el = <div>\n  <span>{value}</span>\n</div>;',
        // Digits/punctuation-only text carries no translatable content.
        "const el = <span>{'42'}</span>;",
        "const el = <hr aria-hidden={'true'} />;",
      ],
      invalid: [
        {
          code: 'const el = <button>Send</button>;',
          errors: [{ messageId: 'hardcodedText', data: { text: 'Send' } }],
        },
        {
          code: "const el = <p>{'Get in touch'}</p>;",
          errors: [{ messageId: 'hardcodedText', data: { text: 'Get in touch' } }],
        },
        {
          code: 'const el = <Input label="Email address" />;',
          errors: [{ messageId: 'hardcodedAttribute', data: { text: 'Email address', attribute: 'label' } }],
        },
        {
          code: 'const el = <img alt="A clinician talking with a patient" />;',
          errors: [
            {
              messageId: 'hardcodedAttribute',
              data: { text: 'A clinician talking with a patient', attribute: 'alt' },
            },
          ],
        },
        {
          code: 'const el = <Input label={"Email address"} />;',
          errors: [{ messageId: 'hardcodedAttribute', data: { text: 'Email address', attribute: 'label' } }],
        },
        {
          // A static template literal, with an interpolation, in output — the static
          // "Hello " fragment is still hard-coded prose (ICU vars are the sanctioned way
          // to interpolate; see the rule's own comment on TASK 1.1.2's "Do NOT").
          code: 'const el = <p>{`Hello ${name}`}</p>;',
          errors: [{ messageId: 'hardcodedText', data: { text: 'Hello' } }],
        },
        {
          code: 'const el = <button title="Close">{icon}</button>;',
          errors: [{ messageId: 'hardcodedAttribute', data: { text: 'Close', attribute: 'title' } }],
        },
      ],
    });
  });
});
