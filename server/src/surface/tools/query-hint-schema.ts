import { z } from 'zod';

/**
 * `hint.testidFoundUnder` on a zero-match reticle_query. Declared here, not inline, because tools.ts
 * is at its line cap; it must still be declared at all, since an undeclared field is stripped from
 * structuredContent without a word.
 */
export const TESTID_FOUND_UNDER_SCHEMA = z
  .string()
  .optional()
  .describe(
    'A TESTID miss whose value IS on the page under another attribute, e.g. data-test-subj: set testIdAttribute in .reticle.json (Vite plugin) or pass it to connect().',
  );
