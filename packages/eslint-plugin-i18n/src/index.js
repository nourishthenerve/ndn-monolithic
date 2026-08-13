import { RULE_NAME } from './constants.js';
import noHardcodedStrings from './no-hardcoded-strings.js';

const plugin = {
  meta: {
    name: '@ndn/eslint-plugin-i18n',
    version: '0.0.0',
  },
  rules: {
    [RULE_NAME]: noHardcodedStrings,
  },
};

export default plugin;
export { FULL_RULE_ID, RULE_NAME } from './constants.js';
