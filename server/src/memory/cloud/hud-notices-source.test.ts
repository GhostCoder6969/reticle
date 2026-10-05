import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hudNoticesSource, type NoticesLoad } from './hud-notices-source.js';

const FILE = { version: 1, notices: [{ id: 'harness-personas', title: 'Let Reticle drive' }] };
const HOUR = 3_600_000;
/** Three cache writes in a loop: milliseconds here, slower on a Windows runner. A bound, not a duration. */
const CACHE_LOOP_TIMEOUT_MS = 20_000;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const cachePath = (): string => join(mkdtempSync(join(tmpdir(), 'notices-')), 'hud-notices.json');

describe('the HUD notices the daemon keeps', () => {
  it('answers from the disk cache at once, then refreshes in the background', async () => {
    const cache = cachePath();
    writeFileSync(cache, JSON.stringify({ etag: '"v1"', fetchedAt: 0, file: FILE }));
    const asked: (string | undefined)[] = [];
    const load: NoticesLoad = (_url, etag) => {
      asked.push(etag);
      return Promise.resolve({ status: 304 });
    };
    const source = hudNoticesSource({ cacheFile: cache, now: () => 10 * HOUR, load });
    expect(source.read().map((n) => n.id)).toEqual(['harness-personas']);
    await flush();
    // Revalidated with the stored ETag, so an unchanged file costs a 304 and no body.
    expect(asked).toEqual(['"v1"']);
  });

  it('stores a new file and its ETag, and serves it', async () => {
    const cache = cachePath();
    const source = hudNoticesSource({
      cacheFile: cache,
      now: () => 0,
      load: () => Promise.resolve({ status: 200, etag: '"v2"', body: JSON.stringify(FILE) }),
    });
    expect(source.read()).toEqual([]);
    await flush();
    expect(source.read().map((n) => n.id)).toEqual(['harness-personas']);
    expect((JSON.parse(readFileSync(cache, 'utf8')) as { etag?: unknown }).etag).toBe('"v2"');
  });

  it(
    'keeps the last good notices when the site is down or answers garbage',
    async () => {
      const cache = cachePath();
      writeFileSync(cache, JSON.stringify({ etag: '"v1"', fetchedAt: 0, file: FILE }));
      for (const load of [
        (): Promise<never> => Promise.reject(new Error('offline')),
        () => Promise.resolve({ status: 200, body: '<html>' }),
        () => Promise.resolve({ status: 500 }),
      ] as NoticesLoad[]) {
        const source = hudNoticesSource({ cacheFile: cache, now: () => 10 * HOUR, load });
        source.read();
        await flush();
        expect(source.read().map((n) => n.id)).toEqual(['harness-personas']);
      }
    },
    CACHE_LOOP_TIMEOUT_MS,
  );

  it('does not ask again while the copy it has is fresh', async () => {
    const cache = cachePath();
    let calls = 0;
    const source = hudNoticesSource({
      cacheFile: cache,
      now: () => 0,
      load: () => {
        calls += 1;
        return Promise.resolve({ status: 200, body: JSON.stringify(FILE) });
      },
    });
    source.read();
    await flush();
    source.read();
    source.read();
    await flush();
    expect(calls).toBe(1);
  });
});
