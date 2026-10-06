/** `testIdAttribute` must reach the generated connect call, or the SDK never hears of it. */
import { describe, expect, it } from 'vitest';
import { connectArgs } from './connect-args.js';

describe('connectArgs testIdAttribute', () => {
  it('forwards a configured attribute', () => {
    expect(JSON.parse(connectArgs({ testIdAttribute: 'data-test-subj' }))).toMatchObject({
      testIdAttribute: 'data-test-subj',
    });
  });

  it('says nothing when unset, so the default stays implicit', () => {
    expect(connectArgs({})).not.toContain('testIdAttribute');
  });
});
