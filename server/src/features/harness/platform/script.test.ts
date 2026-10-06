import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleTool,
  StepEffect,
} from '@reticlehq/core';
import { personasIn, proposeScript } from './script.js';

const flow = {
  version: FLOW_FILE_VERSION,
  name: 'refund',
  createdAt: 0,
  steps: [
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'card' },
      action: ActionType.FILL,
      args: { value: '4242 4242 4242 4242' },
    },
    {
      tool: ReticleTool.ACT,
      anchor: { kind: AnchorKind.TESTID, value: 'pay' },
      action: ActionType.CLICK,
      args: {},
      effect: StepEffect.COMMITS,
    },
  ],
};
const ask = {
  about: 'a shop',
  flows: [flow],
  replay: ['refund'],
  goals: [],
  gaps: [],
  rules: ['r'],
};
const answer = (script: unknown) => (_url: string, init: RequestInit) => {
  sent.push('string' === typeof init.body ? init.body : '');
  return Promise.resolve(new Response(JSON.stringify({ script }), { status: 200 }));
};
let sent: string[] = [];

describe('asking the platform for the drive plan', () => {
  it('sends step hashes, never the values a step typed', async () => {
    sent = [];
    await proposeScript({ url: 'https://p', apiKey: 'k' }, ask, answer(undefined));
    expect(sent[0]).not.toContain('4242');
    const body = JSON.parse(sent[0] ?? '{}') as { flows: unknown[] };
    expect(body.flows[0]).toMatchObject({ name: 'refund', commits: [1] });
  });

  it('runs a plan that passes the checks, and drops one that does not', async () => {
    const good = {
      version: 1,
      source: 'platform',
      journeys: [{ id: 'refund', title: 'Refund', steps: [{ kind: 'replay', flow: 'refund' }] }],
      lanes: [{ id: 'A', journeys: ['refund'] }],
    };
    const platform = { url: 'https://p', apiKey: 'k' };
    expect((await proposeScript(platform, ask, answer(good)))?.source).toBe('platform');
    const orphaned = { ...good, lanes: [] };
    expect(await proposeScript(platform, ask, answer(orphaned))).toBeUndefined();
  });
});

/** From two recorded whole-app runs: new people every time, so no flow was ever driven twice. */
describe('the personas a project already drove', () => {
  const flow = (intent?: string) =>
    ({ name: 'f', version: 1, steps: [], ...(intent === undefined ? {} : { intent }) }) as never;

  it('are read back from their flows, once each, and sent with the next plan', async () => {
    const personas = personasIn([
      flow('Support agent: refunds a captured payment'),
      flow('Support agent: a second flow of the same person'),
      flow('Finance reconciler: exports captured payments'),
      flow('no colon here'),
      flow(),
    ]);
    expect(personas).toEqual([
      { name: 'Support agent', journey: 'refunds a captured payment' },
      { name: 'Finance reconciler', journey: 'exports captured payments' },
    ]);
    let sent: Record<string, unknown> = {};
    await proposeScript(
      { url: 'https://p', apiKey: 'k' },
      { about: '', flows: [], replay: [], goals: [], gaps: [], rules: [], personas },
      (_url, init) => {
        sent = JSON.parse('string' === typeof init.body ? init.body : '{}') as Record<
          string,
          unknown
        >;
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
    );
    expect(sent['personas']).toEqual(personas);
  });
});
