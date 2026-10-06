/**
 * The drive plan, asked of the platform.
 *
 * The platform plans the whole drive: it proposes the personas, orders the saved flows, finds the
 * shared starts to branch from and writes the product's rules into each open journey. What it is
 * sent is what the project already knows, and each saved step goes as a short hash, never its values,
 * which is all a plan needs to tell two steps apart.
 *
 * The answer is not trusted: it must parse as a drive script and pass the same checks a local plan
 * does, or it is dropped and the daemon plans locally.
 */
import { createHash } from 'node:crypto';
import { StepEffect, type FlowFile, type FlowStep } from '@reticlehq/core';
import { DriveScriptSchema, checkScript, type DriveScript } from '@reticlehq/core/artifacts';

const SCRIPTS_PATH = '/v1/harness/scripts';
const TIMEOUT_MS = 90_000;
/** Characters of a step hash: enough to tell a flow's steps apart, too few to carry anything. */
const STEP_HASH_CHARS = 12;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ScriptAsk {
  about: string;
  flows: readonly FlowFile[];
  replay: readonly string[];
  goals: readonly string[];
  gaps: readonly string[];
  rules: readonly string[];
  /** Personas the project already drove; the platform proposes new ones only when there are none. */
  personas?: readonly { name: string; journey: string }[];
}

/** How long a persona's name may be, read back out of a flow's intent. */
const MAX_PERSONA_NAME = 80;
const MAX_PERSONAS = 5;

/**
 * The personas earlier drives used, read from their flows' intents (`Name: journey`). Proposed
 * afresh on every run, they were different people each time, so each run's flows had new names
 * and the old ones were never replayed or updated.
 */
export function personasIn(flows: readonly FlowFile[]): { name: string; journey: string }[] {
  const seen = new Map<string, string>();
  for (const flow of flows) {
    const at = (flow.intent ?? '').indexOf(':');
    if (at <= 0 || MAX_PERSONA_NAME < at) continue;
    const name = (flow.intent ?? '').slice(0, at).trim();
    const journey = (flow.intent ?? '').slice(at + 1).trim();
    if (0 < name.length && 0 < journey.length && !seen.has(name)) seen.set(name, journey);
  }
  return [...seen].slice(0, MAX_PERSONAS).map(([name, journey]) => ({ name, journey }));
}

/** Equal for two steps that drive the same control the same way; the values never leave. */
export function stepHash(step: FlowStep): string {
  return createHash('sha256')
    .update(
      JSON.stringify([step.tool, step.anchor, step.action, step.args, step.steps, step.invoke]),
    )
    .digest('hex')
    .slice(0, STEP_HASH_CHARS);
}

export async function proposeScript(
  platform: { url: string; apiKey: string },
  ask: ScriptAsk,
  doFetch: FetchLike = (url, init) => fetch(url, init),
): Promise<DriveScript | undefined> {
  try {
    const res = await doFetch(`${platform.url}${SCRIPTS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.apiKey}` },
      body: JSON.stringify({
        about: ask.about,
        flows: ask.flows.map((flow) => ({
          name: flow.name,
          ...(flow.intent === undefined ? {} : { intent: flow.intent }),
          needs: flow.needs ?? [],
          steps: flow.steps.map(stepHash),
          commits: flow.steps.flatMap((step, i) => (StepEffect.COMMITS === step.effect ? [i] : [])),
        })),
        replay: ask.replay,
        goals: ask.goals,
        gaps: ask.gaps,
        rules: ask.rules,
        ...(ask.personas === undefined || 0 === ask.personas.length
          ? {}
          : { personas: ask.personas }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const parsed = DriveScriptSchema.safeParse(((await res.json()) as { script?: unknown }).script);
    if (!parsed.success || 0 < checkScript(parsed.data).length) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}
