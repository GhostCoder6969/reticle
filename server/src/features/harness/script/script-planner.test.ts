import { describe, expect, it } from 'vitest';
import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  ReticleTool,
  StepEffect,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { checkScript, ScriptStepKind } from '@reticlehq/core/artifacts';
import { planScript } from './script-planner.js';

const step = (value: string, effect?: StepEffect): FlowStep => ({
  tool: ReticleTool.ACT,
  anchor: { kind: AnchorKind.TESTID, value },
  action: ActionType.CLICK,
  args: {},
  ...(effect === undefined ? {} : { effect }),
});

const flow = (name: string, steps: FlowStep[], needs?: string[], intent?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 0,
  steps,
  ...(needs === undefined ? {} : { needs }),
  ...(intent === undefined ? {} : { intent }),
});

const signin = flow('signin', [step('email'), step('submit')]);
const refundFull = flow('refund-full', [step('orders'), step('refund'), step('full')], ['signin']);
const refundPartial = flow(
  'refund-partial',
  [step('orders'), step('refund'), step('partial'), step('confirm')],
  ['signin'],
  'Support agent: refund part of an order',
);
const settings = flow('settings', [step('settings'), step('save')], ['signin']);
const empty = { personas: [], goals: [], gaps: [] };

describe('planning a drive from what the project knows', () => {
  it('puts prerequisites first, gives each journey its own lane, and passes its own check', () => {
    const script = planScript({
      ...empty,
      flows: [signin, settings, refundFull],
      replay: ['settings', 'refund-full'],
    });
    expect(checkScript(script)).toEqual([]);
    expect(script.lanes.map((lane) => lane.journeys)).toEqual([
      ['signin', 'settings'],
      ['signin', 'refund-full'],
    ]);
  });

  it('turns two flows that start the same way into one checkpoint and a branch', () => {
    const script = planScript({
      ...empty,
      flows: [signin, refundFull, refundPartial],
      replay: ['refund-full', 'refund-partial'],
      personas: [{ name: 'Support agent', journey: 'refund a disputed order' }],
    });
    expect(checkScript(script)).toEqual([]);
    const refund = script.journeys.find((j) => 'refund-full' === j.id);
    expect(refund?.steps.map((s) => s.kind)).toEqual([
      ScriptStepKind.REPLAY,
      ScriptStepKind.CHECKPOINT,
      ScriptStepKind.BRANCH,
    ]);
    expect(refund?.steps[0]).toMatchObject({ flow: 'refund-full', to: 2 });
    const branch = refund?.steps[2];
    expect(
      branch?.kind === ScriptStepKind.BRANCH ? branch.cases.map((c) => c.steps[0]) : [],
    ).toEqual([
      { kind: ScriptStepKind.REPLAY, flow: 'refund-full', at: 2 },
      { kind: ScriptStepKind.REPLAY, flow: 'refund-partial', at: 2 },
    ]);
    // The persona's own open journey runs after sign-in, in a lane of its own.
    const persona = script.journeys.find(
      (j) => 'Support agent' === j.persona && j.id !== 'refund-full',
    );
    expect(persona?.dependsOn).toEqual(['signin']);
    expect(persona?.steps[0]).toMatchObject({ kind: ScriptStepKind.ACT });
  });

  it('runs a prerequisite that commits in one lane only; the others wait on it', () => {
    const pay = flow('pay', [step('card'), step('pay', StepEffect.COMMITS)]);
    const receipt = flow('receipt', [step('receipts')], ['pay']);
    const refund = flow('refund', [step('refunds')], ['pay']);
    const script = planScript({
      ...empty,
      flows: [pay, receipt, refund],
      replay: ['receipt', 'refund'],
    });
    expect(checkScript(script)).toEqual([]);
    expect(script.lanes.map((lane) => lane.journeys)).toEqual([['pay', 'receipt'], ['refund']]);
  });

  it('with nothing saved, still has one open journey to drive', () => {
    const script = planScript({ ...empty, flows: [], replay: [] });
    expect(script.journeys).toHaveLength(1);
    expect(script.journeys[0]?.steps[0]).toMatchObject({ kind: ScriptStepKind.ACT });
  });
});

describe('a branch point', () => {
  it('is never shallower than two steps, even when one flow is short', () => {
    const long = flow('long', [step('a'), step('b'), step('c')]);
    const short = flow('short', [step('a'), step('b')]);
    const script = planScript({ ...empty, flows: [long, short], replay: ['long', 'short'] });
    expect(script.journeys.map((j) => j.steps.map((s) => s.kind))).toEqual([
      [ScriptStepKind.REPLAY],
      [ScriptStepKind.REPLAY],
    ]);
  });
});
