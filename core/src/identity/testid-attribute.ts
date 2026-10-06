/**
 * Which DOM attribute carries a test id. `data-testid` is only the default: Elastic UI marks controls
 * `data-test-subj`, Cypress codebases `data-cy`, and a project names its own with `testIdAttribute`
 * in `.reticle.json`. The build plugin carries that to the SDK; the SDK reads it everywhere a testid
 * is matched, advertised or recorded.
 */

/** The attribute the `testid` locator reads unless a project names its own. */
export const DEFAULT_TESTID_ATTR = 'data-testid';

/**
 * Attributes other test tooling uses for the same job. Only consulted on a MISS, to say "your id is
 * here, under a different attribute" — never to widen what a testid query matches.
 */
export const ALTERNATIVE_TESTID_ATTRS = [
  'data-test-subj',
  'data-cy',
  'data-test',
  'data-qa',
  'data-e2e',
] as const;

/**
 * An attribute name safe to interpolate into a CSS attribute selector. `.` and `:` are legal in an
 * attribute name but not in an unescaped selector, so `data.test` would make every query throw.
 */
export const TESTID_ATTR_PATTERN = /^[a-zA-Z_][\w-]*$/;
