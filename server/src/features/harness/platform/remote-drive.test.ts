import { afterEach, describe, expect, it } from 'vitest';
import { ReticleEnv } from '@reticlehq/core';
import { startRemoteDrives, type RemoteDriveDeps, type RemoteDrives } from './remote-drive.js';

const LINKED = { [ReticleEnv.API_KEY]: 'k', [ReticleEnv.CLOUD_URL]: 'https://p.test/' };

let running: RemoteDrives | undefined;
afterEach(() => running?.stop());

const platform = (drive: unknown) => {
  const calls: { url: string; method: string; body?: unknown; auth: string | undefined }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    const body = 'string' === typeof init.body ? init.body : undefined;
    calls.push({
      url,
      method: init.method ?? 'GET',
      ...(undefined === body ? {} : { body: JSON.parse(body) as unknown }),
      auth: headers['authorization'],
    });
    return Promise.resolve(new Response(JSON.stringify({ drive }), { status: 200 }));
  };
  return { calls, fetch };
};

const start = (overrides: Partial<RemoteDriveDeps>): RemoteDrives => {
  running = startRemoteDrives({
    env: () => Promise.resolve(LINKED),
    connected: () => true,
    drive: () => Promise.resolve({ ok: true, summary: 'proved' }),
    intervalMs: 60_000,
    ...overrides,
  });
  return running;
};

describe('drives the platform chat asked for', () => {
  it('takes a waiting drive, runs it here and reports how it ended', async () => {
    const p = platform({ id: 'ld_1', goal: 'sign up works' });
    const goals: string[] = [];
    await start({
      fetch: p.fetch,
      drive: (goal) => {
        goals.push(goal);
        return Promise.resolve({ ok: true, summary: '1 of 1 proved' });
      },
    }).tick();

    expect(goals).toEqual(['sign up works']);
    expect(p.calls[0]).toMatchObject({
      url: 'https://p.test/v1/harness/local-drives/next',
      method: 'GET',
      auth: 'Bearer k',
    });
    expect(p.calls[1]).toMatchObject({
      url: 'https://p.test/v1/harness/local-drives/ld_1',
      method: 'POST',
      body: { ok: true, summary: '1 of 1 proved' },
    });
  });

  it('reports a drive that threw as failed, in its own words', async () => {
    const p = platform({ id: 'ld_2', goal: 'x' });
    await start({ fetch: p.fetch, drive: () => Promise.reject(new Error('not entitled')) }).tick();
    expect(p.calls[1]?.body).toEqual({ ok: false, summary: 'not entitled' });
  });

  it('does not ask while no app is connected, so the chat can say so', async () => {
    const p = platform({ id: 'ld_3', goal: 'x' });
    await start({ fetch: p.fetch, connected: () => false }).tick();
    expect(p.calls).toHaveLength(0);
  });

  it('does not ask when this machine is not linked', async () => {
    const p = platform(null);
    await start({ fetch: p.fetch, env: () => Promise.resolve({}) }).tick();
    expect(p.calls).toHaveLength(0);
  });

  it('does nothing when no drive is waiting', async () => {
    const p = platform(null);
    let drove = false;
    await start({
      fetch: p.fetch,
      drive: () => {
        drove = true;
        return Promise.resolve({ ok: true, summary: '' });
      },
    }).tick();
    expect(drove).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  it('runs one drive at a time', async () => {
    const p = platform({ id: 'ld_4', goal: 'x' });
    let release: () => void = () => undefined;
    let drives = 0;
    const remote = start({
      fetch: p.fetch,
      drive: () => {
        drives += 1;
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: '' });
        });
      },
    });
    const first = remote.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await remote.tick();
    release();
    await first;
    expect(drives).toBe(1);
  });
});
