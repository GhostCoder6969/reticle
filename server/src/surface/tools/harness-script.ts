/**
 * The Harness with no journey named: plan the drive from what the project knows, then run the plan.
 *
 * Saved flows replay in lanes side by side (each lane its own leased browser context, when the pool
 * can lease one), flows that start the same way are driven once and branched from, and the open
 * journeys (personas, the user's request, unproved intents) go to the model. The plan is drawn on
 * the HUD and redrawn as each part starts and ends.
 */
import { randomUUID } from 'node:crypto';
import { ReticleCommand, ReticleEnv, ScriptStatus } from '@reticlehq/core';
import { PromptContextSchema, checkScript } from '@reticlehq/core/artifacts';
import type { Persona } from '@/features/harness/platform/personas.js';
import { planScript } from '@/features/harness/script/script-planner.js';
import {
  runScript,
  type ScriptPorts,
  type ScriptRun,
} from '@/features/harness/script/script-run.js';
import { CUSTOM_DRIVER_NAME } from '@/features/harness/drivers.js';
import {
  runHarness,
  StopReason,
  type HarnessResult,
  type ModelDriver,
} from '@/features/harness/harness.js';
import { openFillValues } from '@/memory/project/dir/fill-value-store.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { openSessionIntents } from '@/memory/intent/open-intents.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import { leasableAppUrl } from '@/language/flows/flow-tools.js';
import type { ToolDeps } from './tool-kit.js';
import { acquireLeasedSession } from './lease-tools.js';
import { reticleToolset } from './harness-toolset.js';
import { PlanStepKind, planAsText } from './harness-plan.js';
import {
  MSG_HARNESS_DISABLED,
  bankOpenRecording,
  buildDriver,
  flowsThatCheckNothing,
  maxStepsFromEnv,
  narrator,
  pinned,
  preferredDriver,
  readFlows,
  readPlan,
  reconcileFlows,
  recordPersona,
  refusedByPlatform,
  safeRoot,
  withProjectFlows,
  type ExploreOptions,
  type ExploreResult,
} from './harness-explore.js';

/** A request older than this is about some earlier task, not the one being driven. */
const REQUEST_FRESH_MS = 6 * 60 * 60 * 1000;
const MAX_GOAL_CHARS = 500;
/**
 * Lanes at once. Each is a fresh context loading the app cold, and eight against a dev server timed
 * out together. ponytail: a fixed cap; read it from the pool's measured load time if 4 is too few.
 */
const MAX_LANES = 4;
/** How often a scripted drive asks whether autonomous driving was switched off. */
const STOP_POLL_MS = 10_000;

/**
 * Plan the drive, then run the plan: saved flows replayed in lanes side by side, shared starts
 * driven once and branched from, open journeys handed to the model. `undefined` when there is
 * nothing to plan from, so the caller drives the app with no plan, as before.
 */
export async function exploreScript(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions,
  personas: readonly Persona[],
  before: ReadonlySet<string>,
): Promise<ExploreResult | undefined> {
  const reads = withProjectFlows(deps, options.sessionId);
  const plan = await readPlan(reads, options.sessionId);
  const replay = plan.steps.filter((s) => PlanStepKind.REPLAY === s.kind).map((s) => s.target);
  const goals = await memoryGoals(deps, options.sessionId);
  if (0 === replay.length && 0 === personas.length && 0 === goals.length) return undefined;
  const script = planScript({
    flows: await readFlows(reads),
    replay,
    personas,
    goals,
    gaps: plan.steps.filter((s) => PlanStepKind.DRIVE === s.kind).map((s) => s.why),
  });
  if (0 < checkScript(script).length) return undefined;

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  const fills = await openFillValues(deps.fs, safeRoot(deps, options.sessionId));
  const requested =
    options.driverName ?? env[ReticleEnv.HARNESS_DRIVER] ?? (await preferredDriver(env, options));
  // The script replays the saved flows itself; a model handed them too replayed them again per goal.
  const open = { ...plan, steps: plan.steps.filter((s) => PlanStepKind.DRIVE === s.kind) };
  const driverFor = (persona?: string): { driver: ModelDriver; name: string } =>
    options.driver === undefined
      ? buildDriver(env, maxSteps, open, requested, fills, persona)
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driverName = driverFor().name;
  const harness = randomUUID();
  const narrate = narrator(deps, options);

  // Lanes run side by side only in leased contexts; without a pool they take turns on this tab.
  const pool = deps.pool;
  const appUrl = leasableAppUrl(deps, options.sessionId);
  const leasing = pool !== undefined && appUrl !== undefined && 1 < script.lanes.length;
  const projectId = safeProjectId(deps, options.sessionId);
  let off = false;
  const poll = setInterval(() => {
    void refusedByPlatform(env, options).then((refusal) => {
      if (MSG_HARNESS_DISABLED === refusal) off = true;
    });
  }, STOP_POLL_MS);
  poll.unref();

  const ports: ScriptPorts = {
    parallel: leasing ? Math.max(1, Math.min(script.lanes.length, pool.capacity(), MAX_LANES)) : 1,
    stopped: () => off,
    lease: async () => {
      if (!leasing) return { ...pinned(options), release: () => Promise.resolve() };
      const acquire = () => acquireLeasedSession(pool, deps.sessions, appUrl, projectId);
      // A cold dev server can miss the first load while other lanes compile it; the second finds it warm.
      return acquire().catch(acquire);
    },
    toolset: (sessionId, persona) =>
      reticleToolset(deps, {
        ...(sessionId === undefined ? {} : { sessionId }),
        drivenBy: { harness, driver: driverName, ...(persona === undefined ? {} : { persona }) },
      }),
    drive: async (toolset, goal, steps) => {
      const persona =
        personas.find((p) => goal.startsWith(`${p.name}:`)) === undefined ? undefined : goal;
      const ahead = new Set(await reads.flows.list());
      const result = await runHarness(driverFor(persona).driver, toolset, {
        maxSteps: Math.min(steps, maxSteps),
        focus: [planAsText(open), `Focus: ${goal}`].join('\n\n'),
      });
      await bankOpenRecording(toolset, result, persona);
      if (persona !== undefined) {
        const saved = reconcileFlows(ahead, await reads.flows.list(), result.toolCalls);
        await recordPersona(reads, [...saved.savedFlows, ...saved.rewroteFlows], persona);
      }
      return result;
    },
  };

  narrate(
    `Harness plan · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)` +
      (1 < ports.parallel ? `, ${String(ports.parallel)} at once` : ''),
  );
  let run: ScriptRun;
  try {
    run = await runScript(script, ports, (view) => {
      try {
        deps.sessions.resolve(options.sessionId).pushView(ReticleCommand.PLAN, view);
      } catch {
        /* nobody is watching: the plan still runs */
      }
    });
  } finally {
    clearInterval(poll);
    await fills.flush();
  }
  for (const line of run.lines) narrate(line);
  narrate(
    run.stopped
      ? 'Autonomous driving switched off — the Harness stopped. What it drove is kept.'
      : `Harness finished the plan — ${run.lines.filter((l) => l.startsWith('✓')).length} of ${String(run.lines.length)} passed`,
  );

  const sum = (pick: (r: HarnessResult) => number): number =>
    run.drives.reduce((n, r) => n + pick(r), 0);
  const drive: HarnessResult = {
    stopReason: run.stopped ? StopReason.STOPPED : StopReason.FINISHED,
    summary: run.drives
      .map((d) => d.summary)
      .filter((t) => 0 < t.length)
      .join('\n'),
    steps: run.toolCalls.length,
    toolCalls: run.toolCalls,
    usage: {
      input: sum((r) => r.usage.input),
      output: sum((r) => r.usage.output),
      cacheRead: sum((r) => r.usage.cacheRead),
      cacheWrite: sum((r) => r.usage.cacheWrite),
    },
    proved: run.view.lanes.some((lane) =>
      lane.journeys.some((card) => ScriptStatus.PASSED === card.status),
    ),
  };
  const reconciled = reconcileFlows(before, await reads.flows.list(), run.toolCalls);
  const unverifiedFlows = await flowsThatCheckNothing(reads, [
    ...reconciled.savedFlows,
    ...reconciled.rewroteFlows,
  ]);
  return {
    drive,
    plan,
    driverName,
    ...reconciled,
    unverifiedFlows,
    goals: [],
    planLines: [
      `Plan · ${String(script.journeys.length)} journeys in ${String(script.lanes.length)} lane(s)`,
      ...run.lines,
    ],
  };
}

/** What the project still owes, in its own words: the user's recent request, then open intents. */
async function memoryGoals(deps: ToolDeps, sessionId?: string): Promise<string[]> {
  const goals: string[] = [];
  try {
    const parsed = PromptContextSchema.safeParse(
      JSON.parse(await deps.fs.readFile(reticleDirPaths(sessionRoot(deps, sessionId)).request)),
    );
    const at = parsed.success ? parsed.data.at : undefined;
    const request = parsed.success ? parsed.data.request : undefined;
    if (request !== undefined && at !== undefined && deps.now() - at < REQUEST_FRESH_MS) {
      goals.push(request);
    }
  } catch {
    /* no request declared: the common case */
  }
  try {
    for (const intent of await openSessionIntents(deps, sessionId)) goals.push(intent.statement);
  } catch {
    /* no intent ledger */
  }
  return [...new Set(goals.map((g) => g.trim().slice(0, MAX_GOAL_CHARS)))].filter(
    (g) => 0 < g.length,
  );
}

function safeProjectId(deps: ToolDeps, sessionId?: string): string | undefined {
  try {
    return sessionTarget(deps, sessionId).projectId;
  } catch {
    return undefined;
  }
}
