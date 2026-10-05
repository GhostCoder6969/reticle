import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { checkGoals, goalsIn, unprovedGoals } from './goals.js';

describe('the goals a drive was asked to prove (#1316)', () => {
  it('are the strings the persona quoted', () => {
    expect(
      goalsIn('check that "Ada Lovelace" and “Grace Hopper” are listed, don\'t delete'),
    ).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(goalsIn('click around')).toEqual([]);
    expect(goalsIn(undefined)).toEqual([]);
  });

  it('are each checked with an assert, and a drive that saw neither proves neither', async () => {
    const asked: unknown[] = [];
    const checks = await checkGoals(
      (name, args) => {
        asked.push([name, args]);
        return Promise.resolve({ verified: 'Ada Lovelace' === textOf(args) ? 'yes' : 'no' });
      },
      ['Ada Lovelace', 'Grace Hopper'],
    );
    expect(asked[0]).toEqual([
      ReticleTool.ASSERT,
      { predicate: { kind: 'text', contains: 'Ada Lovelace' } },
    ]);
    expect(checks).toEqual([
      { text: 'Ada Lovelace', verified: 'yes' },
      { text: 'Grace Hopper', verified: 'no' },
    ]);
    expect(unprovedGoals(checks)).toContain('"Grace Hopper" (no)');
  });

  it('counts a check that could not run as not proved', async () => {
    const checks = await checkGoals(() => Promise.reject(new Error('tab gone')), ['Ada']);
    expect(checks).toEqual([{ text: 'Ada', verified: 'unknown' }]);
    expect(unprovedGoals([{ text: 'Ada', verified: 'yes' }])).toBeUndefined();
  });
});

function textOf(args: Record<string, unknown>): unknown {
  return (args['predicate'] as { contains?: unknown }).contains;
}
