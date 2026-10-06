/**
 * A drive somebody asked for in the platform's chat, run here, on their own machine.
 *
 * The platform cannot open `localhost`, and it never tries: the chat files the drive on the platform,
 * and this daemon — which already calls out to the platform for every Harness turn — asks whether one
 * is waiting for its project, drives the app it has connected, and reports how it ended. Every call
 * goes OUT from this machine, so nothing listens for the platform and no port is opened.
 *
 * It only asks while an app is connected. A drive taken with nothing to drive would fail for a reason
 * the person can fix in ten seconds (open the app), and leaving it unclaimed lets the chat tell them
 * exactly that. One drive at a time: a second request waits for the first to finish.
 */
import { serverOptionsFromEnv } from './server-driver.js';

const NEXT_PATH = '/v1/harness/local-drives/next';
const RESULT_PATH = '/v1/harness/local-drives';
/**
 * How often to ask while an app is connected.
 *
 * ponytail: a poll, one small GET per interval per connected daemon; a long-poll or a stream on the
 * platform side is the upgrade if the chat's wait for a claim ever needs to be shorter than this.
 */
export const REMOTE_DRIVE_POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteDriveOutcome {
  ok: boolean;
  summary: string;
}

export interface RemoteDriveDeps {
  /** The environment with this machine's linked credential in it, resolved on every ask. */
  env: () => Promise<Record<string, string | undefined>>;
  /** Whether an app is connected to drive. */
  connected: () => boolean;
  /** Drive the app toward `goal`. A throw is reported as a failed drive, in its own words. */
  drive: (goal: string) => Promise<RemoteDriveOutcome>;
  fetch?: FetchLike;
  intervalMs?: number;
  /** A line for the daemon log. */
  log?: (line: string) => void;
}

export interface RemoteDrives {
  /** One ask, now. Resolves once any drive it took has been reported. */
  tick: () => Promise<void>;
  stop: () => void;
}

export function startRemoteDrives(deps: RemoteDriveDeps): RemoteDrives {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  let busy = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (busy || stopped || !deps.connected()) return;
    const platform = serverOptionsFromEnv(await deps.env());
    if (platform === undefined) return;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${platform.apiKey}`,
    };
    busy = true;
    try {
      const res = await doFetch(`${platform.url}${NEXT_PATH}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const drive = ((await res.json()) as { drive?: { id?: unknown; goal?: unknown } | null })
        .drive;
      if (null === drive || undefined === drive) return;
      if ('string' !== typeof drive.id || 'string' !== typeof drive.goal) return;
      deps.log?.(`reticle: driving a request from the platform chat: ${drive.goal}`);
      let outcome: RemoteDriveOutcome;
      try {
        outcome = await deps.drive(drive.goal);
      } catch (error) {
        outcome = { ok: false, summary: error instanceof Error ? error.message : String(error) };
      }
      await doFetch(`${platform.url}${RESULT_PATH}/${encodeURIComponent(drive.id)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(outcome),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Offline, or the platform is down: the next tick asks again. The local daemon never fails for it.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? REMOTE_DRIVE_POLL_MS);
  timer.unref();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
