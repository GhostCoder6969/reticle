import { describe, expect, it } from 'vitest';
import { runHarness, type HarnessToolset, type ModelDriver } from '../harness.js';
import { serverDriver } from './server-driver.js';

const toolset = (seen: string[]): HarnessToolset => ({
  tools: [{ name: 'reticle_act_and_wait', description: 'act', inputSchema: { type: 'object' } }],
  invoke: (name, args) => {
    seen.push(`${name}:${JSON.stringify(args)}`);
    return Promise.resolve({ verified: 'yes' });
  },
});

function platform(script: Record<string, (body: Record<string, unknown>) => unknown>) {
  const asked: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    asked.push({ path, body });
    const answer = (script[path] ?? (() => ({ status: 404 })))(body);
    const status = (answer as { status?: number }).status;
    return Promise.resolve(
      'number' === typeof status
        ? new Response('{}', { status })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  };
  return { asked, fetch };
}

describe('the platform drives, this machine executes', () => {
  it('starts a run, executes each call the platform chooses, and reports the outcomes back', async () => {
    const { asked, fetch } = platform({
      '/v1/harness/runs': () => ({ runId: 'hr_1' }),
      '/v1/harness/runs/hr_1/turn': (body) =>
        0 === body['turn']
          ? {
              turn: 0,
              calls: [{ id: 't1', name: 'reticle_act_and_wait', args: { ref: 'e1' } }],
              text: 'clicking',
              done: false,
              status: 'running',
            }
          : { turn: 1, calls: [], text: 'ok', done: true, status: 'finished', summary: 'proved' },
    });
    const executed: string[] = [];
    const result = await runHarness(
      serverDriver({ url: 'https://p.test', apiKey: 'rk_live_x', persona: 'a shopper', fetch }),
      toolset(executed),
    );
    expect(executed).toEqual(['reticle_act_and_wait:{"ref":"e1"}']);
    expect(result.stopReason).toBe('finished');
    expect(result.summary).toBe('proved');
    expect(asked[0]?.body).toMatchObject({ persona: 'a shopper' });
    // The second turn carried exactly the outcome of the call it was asked to make.
    expect(asked[2]?.body).toMatchObject({
      turn: 1,
      outcomes: [{ id: 't1', name: 'reticle_act_and_wait', result: { verified: 'yes' } }],
    });
  });

  it('drives locally when the platform does not run the Harness yet', async () => {
    const { fetch } = platform({});
    const local: ModelDriver = {
      turn: () =>
        Promise.resolve({
          text: '',
          calls: [{ id: 'f', name: 'finish', args: { summary: 'local' } }],
        }),
    };
    const why: string[] = [];
    const result = await runHarness(
      serverDriver({
        url: 'https://p.test',
        apiKey: 'k',
        fetch,
        fallback: local,
        onFallback: (w) => why.push(w),
      }),
      toolset([]),
    );
    expect(why).toHaveLength(1);
    expect(result.summary).toBe('local');
  });

  it('says why the platform refused, and does not fall back from a refusal', async () => {
    const { fetch } = platform({ '/v1/harness/runs': () => ({ status: 402 }) });
    const result = await runHarness(
      serverDriver({
        url: 'https://p.test',
        apiKey: 'k',
        fetch,
        fallback: { turn: () => Promise.reject(new Error('no')) },
      }),
      toolset([]),
    );
    expect(result.stopReason).toBe('broken');
    expect(result.error).toContain('402');
  });
});
