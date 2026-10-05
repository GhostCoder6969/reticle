/**
 * The platform's Harness, seen from the daemon: the platform decides, this machine executes.
 *
 * Every turn is one HTTPS request this daemon makes: it posts what the last calls did, and the
 * platform answers with the next calls, chosen by its own model, persona and verification mode. The
 * loop around it (`runHarness`) is unchanged: it executes the calls through Reticle's own tools and
 * hands the outcomes back here. Nothing is held open between turns, a lost response is retried with
 * the same turn number, and the platform answers that from its record without a second model call.
 *
 * A platform that does not serve the Harness yet (404 at start) is not an error a person can act
 * on: the drive carries on with `fallback`, the local path this machine used before, and says so.
 */
import { ReticleEnv, cloudUrlFrom } from '@reticlehq/core';
import type { HarnessTool, ModelDriver, ModelTurn, ToolOutcome, ToolRequest } from '../harness.js';

export const SERVER_DRIVER_NAME = 'server';
const RUNS_PATH = '/v1/harness/runs';
const TURN_TIMEOUT_MS = 110_000;
const RETRIES = 1;
const NOT_SERVED = new Set([404, 405]);
const FINISH = 'finish';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ServerDriverOptions {
  url: string;
  apiKey: string;
  persona?: string;
  /** journey | brute-force | stress | madman | security. The platform defaults to journey. */
  mode?: string;
  /** What `.reticle` already knows, as text: saved journeys and open intents. */
  plan?: string;
  maxSteps?: number;
  fallback?: ModelDriver;
  fetch?: FetchLike;
  /** Told once when the drive falls back, so the result can say which driver drove. */
  onFallback?: (why: string) => void;
}

interface TurnReply {
  turn: number;
  calls: ToolRequest[];
  text: string;
  done: boolean;
  status: string;
  summary?: string;
}

/** The platform's url and this project's key, when the machine is linked. */
export function serverOptionsFromEnv(
  env: Record<string, string | undefined>,
): { url: string; apiKey: string } | undefined {
  const url = cloudUrlFrom(env);
  const apiKey = env[ReticleEnv.API_KEY];
  return url === undefined || apiKey === undefined || 0 === apiKey.length
    ? undefined
    : { url: url.replace(/\/+$/, ''), apiKey };
}

export class ServerHarnessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function serverDriver(options: ServerDriverOptions): ModelDriver {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let runId: string | undefined;
  let turn = 0;
  let seen = 0;
  let fellBack = false;

  const call = async (path: string, body: unknown): Promise<unknown> => {
    let last: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      try {
        const res = await doFetch(`${options.url}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok) {
          const message = errorMessage(text) ?? `the platform answered ${String(res.status)}`;
          // A refusal is an answer; only a network failure is worth asking again.
          throw new ServerHarnessError(message, res.status);
        }
        return JSON.parse(text) as unknown;
      } catch (error) {
        if (error instanceof ServerHarnessError) throw error;
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };

  return {
    async turn(input): Promise<ModelTurn> {
      if (fellBack && options.fallback !== undefined) return options.fallback.turn(input);
      if (runId === undefined) {
        try {
          const started = (await call(RUNS_PATH, {
            ...(options.persona === undefined ? {} : { persona: options.persona }),
            ...(options.mode === undefined ? {} : { mode: options.mode }),
            ...(options.plan === undefined ? {} : { plan: options.plan }),
            ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
            tools: input.tools.filter((t) => FINISH !== t.name).map(toolSpec),
          })) as { runId?: unknown };
          if ('string' !== typeof started.runId)
            throw new ServerHarnessError('the platform started no run', 502);
          runId = started.runId;
        } catch (error) {
          if (
            error instanceof ServerHarnessError &&
            NOT_SERVED.has(error.status) &&
            options.fallback !== undefined
          ) {
            fellBack = true;
            options.onFallback?.('the platform does not run the Harness yet');
            return options.fallback.turn(input);
          }
          throw error;
        }
      }
      // Only what happened since the last turn: the platform holds everything before it.
      const fresh = input.history.slice(seen);
      seen = input.history.length;
      const outcomes = fresh.flatMap((entry) =>
        'tool' === entry.role ? entry.outcomes.map(outcomeOf) : [],
      );
      const reply = (await call(`${RUNS_PATH}/${encodeURIComponent(runId)}/turn`, {
        turn,
        outcomes,
      })) as TurnReply;
      turn = reply.turn + 1;
      if (reply.done) {
        // The platform has finished: `finish` ends the local loop the same way a local model would.
        return {
          text: reply.text,
          calls: [
            {
              id: `server-finish-${String(reply.turn)}`,
              name: FINISH,
              args: { summary: reply.summary ?? reply.text },
            },
          ],
        };
      }
      return { text: reply.text, calls: reply.calls };
    },
  };
}

function toolSpec(tool: HarnessTool): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function outcomeOf(o: ToolOutcome): {
  id: string;
  name: string;
  result: unknown;
  isError: boolean;
} {
  return { id: o.id, name: o.name, result: o.result, isError: o.isError };
}

function errorMessage(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } };
    return 'string' === typeof body.error?.message ? body.error.message : undefined;
  } catch {
    return undefined;
  }
}
