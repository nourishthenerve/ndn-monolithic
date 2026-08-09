import { RULE_NAME } from './constants.js';
import noDestructivePrimitives from './no-destructive-primitives.js';

const plugin = {
  meta: {
    name: '@ndn/eslint-plugin-no-destructive',
    version: '0.0.0',
  },
  rules: {
    [RULE_NAME]: noDestructivePrimitives,
  },
};

export default plugin;
export {
  findForbiddenDisableComments,
  isForbiddenDisableDirective,
} from './disable-comment-guard.js';
export { FULL_RULE_ID, RULE_NAME } from './constants.js';
