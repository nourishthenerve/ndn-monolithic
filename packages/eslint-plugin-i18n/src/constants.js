export const RULE_NAME = 'no-hardcoded-strings';

// Registered under the `ndnI18n` plugin key, not `ndn` — the existing
// `ndn` key (packages/eslint-plugin-no-destructive) is registered
// repo-wide in eslint.config.js. Flat config's `plugins` merge is
// last-write-wins per key across matching config blocks, so reusing `ndn`
// here would silently replace the destructive-primitive guard's plugin
// object for every file under apps/web/**, breaking TASK 0.3.1's rule
// exactly where D-04's own PR body requirements (protected stores, etc.)
// still apply.
export const FULL_RULE_ID = `ndnI18n/${RULE_NAME}`;
