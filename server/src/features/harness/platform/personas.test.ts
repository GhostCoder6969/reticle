import { describe, expect, it } from 'vitest';
import { proposePersonas } from './personas.js';

const platform = { url: 'https://p.test', apiKey: 'rk_live_x' };
const answering = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('the personas the platform proposes', () => {
  it('keeps the well-formed ones', async () => {
    const personas = await proposePersonas(
      platform,
      'a shop',
      answering(200, {
        personas: [{ name: 'Returning buyer', journey: 'reorders a past purchase' }, { name: 3 }],
      }),
    );
    expect(personas).toEqual([{ name: 'Returning buyer', journey: 'reorders a past purchase' }]);
  });

  it('proposes none when the platform cannot answer, so the drive goes ahead without', async () => {
    expect(await proposePersonas(platform, 'a shop', answering(402, {}))).toEqual([]);
    expect(
      await proposePersonas(platform, 'a shop', () => Promise.reject(new Error('offline'))),
    ).toEqual([]);
  });
});
