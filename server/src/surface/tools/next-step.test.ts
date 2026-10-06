import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextText, nextStep, resetNextStep } from './next-step.js';

const NOW = 1_800_000_000_000;
const root = (files: Record<string, unknown> = {}): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'reticle-next-')), '.reticle');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(body));
  return dir;
};
const verdict = (r: string, tool = 'reticle_act_and_wait') =>
  nextStep({ tool, verdict: true, root: r, now: NOW });

beforeEach(() => resetNextStep());

describe('what the agent is told to do next', () => {
  it('asks for the user request first, until it has been declared', () => {
    const r = root();
    expect(verdict(r)).toBe(NextText.DECLARE);
    writeFileSync(join(r, 'request.json'), JSON.stringify({ at: NOW - 1000, statements: [] }));
    expect(verdict(r)).toBe(NextText.FINISH);
  });

  it('names a sync failure on a linked project, ahead of everything else', () => {
    const r = root({
      'cloud.json': { projectId: 'p' },
      'request.json': { at: NOW },
      'cloud-state.json': { lastError: 'the platform answered 401' },
    });
    expect(verdict(r)).toBe(NextText.SYNC_PROBLEM('the platform answered 401'));
  });

  it('on a linked project with nothing wrong, says the run syncs on its own', () => {
    const r = root({ 'cloud.json': { projectId: 'p' }, 'request.json': { at: NOW } });
    expect(verdict(r)).toBe(NextText.FINISH_LINKED);
  });

  it('tells an unlinked project how to connect on the first verdict and every fifth after', () => {
    const r = root({ 'request.json': { at: NOW } });
    const said = Array.from({ length: 6 }, () => verdict(r));
    expect(said.map((s) => s === NextText.CONNECT)).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('stays quiet on a read with nothing pending, and never asks the intent tool to declare', () => {
    const r = root({ 'request.json': { at: NOW } });
    expect(nextStep({ tool: 'reticle_look', verdict: false, root: r, now: NOW })).toBeUndefined();
    expect(
      nextStep({ tool: 'reticle_intent', verdict: false, root: root(), now: NOW }),
    ).toBeUndefined();
  });
});
