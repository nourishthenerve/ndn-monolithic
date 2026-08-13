// Plain JS, not TS — same reason as eslint-plugin-no-destructive's rule:
// ESLint's flat config loads eslint.config.js directly with Node's module
// loader (no build step exists in this repo), so a rule this central can't
// depend on a TS→JS compile step. astro-eslint-parser produces a JSX-
// compatible AST for the template portion of .astro files (JSXText,
// JSXExpressionContainer, JSXAttribute — same node types real JSX/TSX use),
// so this rule's visitors cover both apps/web's .astro pages and any future
// .tsx React island with the same logic.

// Content-bearing attributes only — deliberately NOT every JSX attribute.
// Structural/technical attributes (type, name, id, href, className, rel,
// autoComplete, dir, lang, role…) commonly hold literal strings that are
// not user-facing prose, and flagging them would bury real violations in
// noise (same "avoid flooding every file with false positives" restraint
// no-destructive-primitives.js documents for its own SQL patterns).
const CONTENT_ATTRIBUTES = new Set([
  'label',
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);

const HAS_LETTER = /\p{L}/u;

/** @param {string} text */
function hasTranslatableContent(text) {
  return HAS_LETTER.test(text);
}

/** @param {any} node */
function isStaticStringLike(node) {
  if (!node) {
    return false;
  }
  if (node.type === 'Literal') {
    return typeof node.value === 'string';
  }
  // A TemplateLiteral is flagged whether or not it has expressions — the
  // static quasis around an interpolation are still hard-coded prose that
  // belongs in an ICU catalogue entry with a `{var}` placeholder, not a JS
  // template string (see this rule's own "Do NOT" in docs/plan/05
  // TASK 1.1.2: "hard-code date/plural formatting outside the ICU
  // catalogue").
  return node.type === 'TemplateLiteral';
}

/** @param {any} node */
function staticText(node) {
  if (node.type === 'Literal') {
    return String(node.value);
  }
  return node.quasis.map((/** @type {any} */ quasi) => quasi.value.raw).join(' ');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban literal user-facing text in JSX/Astro output not wrapped by t() — D-04 (docs/plan/01-decisions.md): no hard-coded copy anywhere, ever.',
    },
    schema: [],
    messages: {
      hardcodedText:
        'Hard-coded copy "{{text}}" must be wrapped in t() (D-04: no hard-coded copy anywhere, ever).',
      hardcodedAttribute:
        'Hard-coded copy "{{text}}" on the "{{attribute}}" attribute must be wrapped in t() (D-04: no hard-coded copy anywhere, ever).',
    },
  },
  create(context) {
    // JSX-specific node types (astro-eslint-parser's JSX-compatible
    // template AST, or real .tsx JSX) aren't part of @types/eslint's
    // `Rule.RuleListener`, so TypeScript can't contextually type these
    // handlers' parameters — annotated explicitly for checkJs.
    /** @param {any} node */
    function checkText(node) {
      const text = node.value.trim();
      if (hasTranslatableContent(text)) {
        context.report({ node, messageId: 'hardcodedText', data: { text } });
      }
    }

    return {
      // Plain static text in a template is `JSXText` when nested inside a
      // JSXElement's children, but astro-eslint-parser emits the
      // Astro-specific `AstroRawText` (identical shape, different `type`
      // discriminant) for text elsewhere in the template — both need the
      // same check, or most real .astro copy silently escapes this rule.
      JSXText: checkText,
      AstroRawText: checkText,
      /** @param {any} node */
      JSXExpressionContainer(node) {
        // Attribute-valued containers (label={'...'}) are handled by the
        // JSXAttribute visitor below — reporting both would double-count
        // the same violation.
        if (node.parent && node.parent.type === 'JSXAttribute') {
          return;
        }
        const expression = node.expression;
        if (!isStaticStringLike(expression)) {
          return;
        }
        const text = staticText(expression).trim();
        if (hasTranslatableContent(text)) {
          context.report({ node, messageId: 'hardcodedText', data: { text } });
        }
      },
      /** @param {any} node */
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || !CONTENT_ATTRIBUTES.has(node.name.name)) {
          return;
        }
        if (!node.value) {
          return;
        }
        const expression =
          node.value.type === 'JSXExpressionContainer' ? node.value.expression : node.value;
        if (!isStaticStringLike(expression)) {
          return;
        }
        const text = staticText(expression).trim();
        if (hasTranslatableContent(text)) {
          context.report({
            node: node.value,
            messageId: 'hardcodedAttribute',
            data: { text, attribute: node.name.name },
          });
        }
      },
    };
  },
};

export default rule;
