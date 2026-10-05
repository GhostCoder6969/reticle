import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { LOCAL_RUNS_MOMENT, resetPlatformMoments, takePlatformMoment } from './platform-moment.js';

const YES = { verified: 'yes' };

function project(runs: number): string {
  const root = join(mkdtempSync(join(tmpdir(), 'moment-')), '.reticle');
  mkdirSync(join(root, 'runs'), { recursive: true });
  for (let i = 0; i < runs; i += 1) writeFileSync(join(root, 'runs', `r${String(i)}.json`), '{}');
  return root;
}
const linkedTo = (linked: boolean) => ({
  fs: createNodeFileSystem(),
  linkedCloud: () => Promise.resolve(linked ? { url: 'https://x', apiKey: 'k' } : null),
});
const take = (root: string, linked: boolean, raw: Record<string, unknown> = YES) =>
  takePlatformMoment(linkedTo(linked), raw, () => root);

afterEach(resetPlatformMoments);

describe('mentioning the platform at a real moment, once', () => {
  it('says it once a project has verified runs only on this machine, and never again', async () => {
    const root = project(LOCAL_RUNS_MOMENT);
    expect(await take(root, false)).toContain(
      `${String(LOCAL_RUNS_MOMENT)} verified runs of this project exist only on this machine`,
    );
    expect(await take(root, false)).toBeUndefined();
    // A restarted daemon remembers, through .reticle.
    resetPlatformMoments();
    expect(await take(root, false)).toBeUndefined();
  });

  it('stays quiet before the moment, on a linked machine, and on anything but a proved verdict', async () => {
    expect(await take(project(LOCAL_RUNS_MOMENT - 1), false)).toBeUndefined();
    expect(await take(project(LOCAL_RUNS_MOMENT), true)).toBeUndefined();
    expect(await take(project(LOCAL_RUNS_MOMENT), false, { verified: 'unknown' })).toBeUndefined();
  });
});
