import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  firstRunWiring,
  projectDirectoryOf,
  readInitOutput,
  type RunCli,
} from './first-run-wiring.js';

const PLAN = [
  '  [✓] Install @reticlehq/vite-plugin → package.json',
  '  [✓] Vite plugin → vite.config.ts',
  '  [·] Reticle config → .reticle.json',
  '{',
  '  "ok": true,',
  '  "url": "http://localhost:5173/"',
  '}',
  '',
].join('\n');

describe('wiring the app on first use', () => {
  it('runs init in the project against this daemon, once, and reports what it changed', async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const run: RunCli = (args, cwd) => {
      calls.push({ args, cwd });
      return Promise.resolve({ code: 0, stdout: PLAN, stderr: '' });
    };
    const wiring = firstRunWiring({ port: 4410, cliPath: '/x/cli.js', run });
    const first = await wiring.wire('/work/shop');
    expect(calls).toEqual([
      { args: ['init', '--no-mcp', '--json', '--port', '4410'], cwd: '/work/shop' },
    ]);
    expect(first.ok).toBe(true);
    expect(first.url).toBe('http://localhost:5173/');
    expect(first.steps.map((s) => s.target)).toEqual([
      'package.json',
      'vite.config.ts',
      '.reticle.json',
    ]);
    // Never twice on the same files: a second ask gets the first answer.
    expect(await wiring.wire('/work/shop')).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('says why it stopped when init fails', async () => {
    const run: RunCli = () =>
      Promise.resolve({
        code: 1,
        stdout: 'no framework detected\n',
        stderr: 'init: no dev script\n',
      });
    const out = await firstRunWiring({ port: 4400, cliPath: 'c', run }).wire('/w');
    expect(out).toMatchObject({ ok: false, error: 'init: no dev script', steps: [] });
  });

  it('does not guess a project for a daemon in the home directory or outside any package', () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const app = mkdtempSync(join(tmpdir(), 'app-'));
    writeFileSync(join(app, 'package.json'), '{}');
    expect(projectDirectoryOf(home, home)).toBeUndefined();
    expect(projectDirectoryOf(mkdtempSync(join(tmpdir(), 'bare-')), home)).toBeUndefined();
    expect(projectDirectoryOf(app, home)).toBe(app);
  });

  it('reads no result from an init that printed none', () => {
    expect(readInitOutput('plain text').result).toBeUndefined();
  });
});
