// Plain JS, not TS: ESLint's flat config loads eslint.config.js directly with
// Node's module loader (no build step exists yet in this repo), so a rule this
// central to every package's lint run can't depend on a TS→JS compile step.

// AWS SDK v3 command constructors and the BatchWriteItem delete branch. Banning
// the bare identifier (not just call sites) also catches imports, re-exports,
// and shadow re-declarations of the same name.
//
// TASK 2.4.1: `AdminDeleteUserCommand` (Cognito) joins the set — identity is
// C-03's protected estate too, and the same reasoning applies: "no code path
// calls it" is stronger as a repo-wide lint fact than as a habit reviewers
// have to remember to check on every clinician/patient-admin PR going
// forward. `AdminDisableUserCommand`/`AdminEnableUserCommand` (deactivate/
// reactivate) are unaffected — deactivation is the only lifecycle this
// codebase's identity layer has.
const BANNED_IDENTIFIERS = new Set([
  'DeleteItemCommand',
  'DeleteObjectCommand',
  'DeleteObjectsCommand',
  'DeleteRequest',
  'AdminDeleteUserCommand',
]);

// Multi-word, statement-shaped patterns only — a bare "delete"/"drop" is
// common in ordinary UI copy (button labels, confirmation text) and would
// otherwise flood every app/service with false positives.
const SQL_PATTERNS = [
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|COLUMN)\b/i,
];

const S3_DELETE_ACTION = /^s3:DeleteObject/i;

const INFRA_PATH = /(^|[/\\])infra[/\\]/;

/** @param {string} text */
function matchesSqlPattern(text) {
  return SQL_PATTERNS.some((pattern) => pattern.test(text));
}

/** @param {any} node */
function findEnclosingObjectExpression(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'ObjectExpression') {
      return current;
    }
    current = current.parent;
  }
  return null;
}

// Allowlist per TASK 0.3.1 step 2: only an infra/ PolicyStatement-shaped
// object literal with `effect`/`Effect: Deny` may reference an s3:DeleteObject*
// action — that's how the two-layer guard authors the IAM-side deny (0.3.2).
/** @param {any} objectExpression */
function objectHasDenyEffect(objectExpression) {
  if (!objectExpression) {
    return false;
  }
  return objectExpression.properties.some((/** @type {any} */ prop) => {
    if (prop.type !== 'Property') {
      return false;
    }
    const keyName = prop.key.type === 'Identifier' ? prop.key.name : prop.key.value;
    if (typeof keyName !== 'string' || keyName.toLowerCase() !== 'effect') {
      return false;
    }
    const { value } = prop;
    if (value.type === 'Literal' && typeof value.value === 'string') {
      return value.value.toLowerCase() === 'deny';
    }
    if (value.type === 'MemberExpression' && value.property.type === 'Identifier') {
      return value.property.name.toLowerCase() === 'deny';
    }
    return false;
  });
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban destructive data-plane primitives (delete commands, raw SQL DELETE/TRUNCATE/DROP, s3:DeleteObject* actions) per docs/plan/00-conventions.md',
    },
    schema: [],
    messages: {
      bannedIdentifier:
        'Destructive primitive "{{name}}" is prohibited (docs/plan/00-conventions.md: soft-delete flags only).',
      bannedSql:
        'Raw SQL DELETE/TRUNCATE/DROP statements are prohibited (docs/plan/00-conventions.md).',
      bannedS3Delete:
        'IAM action "{{action}}" grants object deletion; only allowed inside an infra/ PolicyStatement with effect: Deny.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (BANNED_IDENTIFIERS.has(node.name)) {
          context.report({ node, messageId: 'bannedIdentifier', data: { name: node.name } });
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string') {
          return;
        }
        if (S3_DELETE_ACTION.test(node.value)) {
          const inInfra = INFRA_PATH.test(context.filename);
          const enclosingObject = findEnclosingObjectExpression(node);
          const isAllowlistedDeny = inInfra && objectHasDenyEffect(enclosingObject);
          if (!isAllowlistedDeny) {
            context.report({ node, messageId: 'bannedS3Delete', data: { action: node.value } });
          }
          return;
        }
        if (matchesSqlPattern(node.value)) {
          context.report({ node, messageId: 'bannedSql' });
        }
      },
      TemplateElement(node) {
        const text = node.value.cooked ?? node.value.raw;
        if (matchesSqlPattern(text)) {
          context.report({ node, messageId: 'bannedSql' });
        }
      },
    };
  },
};

export default rule;
