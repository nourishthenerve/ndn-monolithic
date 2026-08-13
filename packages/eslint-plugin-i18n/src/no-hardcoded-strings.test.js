import * as astroParser from 'astro-eslint-parser';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
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

// TASK 1.2.3: the `<script>`/`<style>` exemption is specific to how the
// *real* astro-eslint-parser categorises those tag bodies (`AstroRawText`
// — see no-hardcoded-strings.js's own comment) — plain JSX has no such
// node type, so the espree-based suite above can't exercise it. Spinning
// up the real parser here, exactly as eslint.config.js configures it for
// `.astro` files, is the only way to prove this against the actual
// behaviour that broke BaseLayout.astro's cookie-consent script.
const astroRuleTester = new RuleTester({
  languageOptions: {
    parser: astroParser,
    parserOptions: {
      parser: tseslint.parser,
      extraFileExtensions: ['.astro'],
      sourceType: 'module',
    },
  },
});

describe('ndnI18n/no-hardcoded-strings — real .astro parsing', () => {
  it('does not flag code/comments inside <script>/<style>, but still flags real template copy', () => {
    astroRuleTester.run('no-hardcoded-strings', rule, {
      valid: [
        `---
const x = 1;
---
<html>
<body>
<script>
  // a comment with plenty of letters in it
  import { setConsent } from '../scripts/consent.js';
  setConsent(['analytics']);
</script>
</body>
</html>
`,
        `---
---
<html>
<body>
<style>
  .ndn-cookie-banner { color: red; }
</style>
</body>
</html>
`,
      ],
      invalid: [
        {
          code: `---
---
<html>
<body>
<p>Hard-coded copy</p>
</body>
</html>
`,
          errors: [{ messageId: 'hardcodedText', data: { text: 'Hard-coded copy' } }],
        },
      ],
    });
  });
});
