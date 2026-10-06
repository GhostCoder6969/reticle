/**
 * One autonomous drive of a connected app, and what it left behind.
 *
 * This is the glue between the loop, the model and Reticle's own tools — and the place where the
 * economics of the feature are decided. A drive costs a model; a SAVED FLOW costs nothing to run
 * again. So the thing this returns that matters is not the model's account of what it did (which
 * nothing grades) but the flows that now exist on disk, because every future run replays those
 * deterministically with no model in the loop at all.
 */

import { serverDriver, serverOptionsFromEnv } from '@/features/harness/platform/server-driver.js';
import { proposePersonas, type Persona } from '@/features/harness/platform/personas.js';
import { randomUUID } from 'node:crypto';
import { ReticleEnv, ReticleTool, asProjectId, cloudUrlFrom, asRecord } from '@reticlehq/core';
import { projectForRoot } from '@/memory/project/project-for-root.js';
import type { ToolDeps } from './tool-kit.js';
import {
  harnessDriver,
  harnessOptionsFromEnv,
  type HarnessDriverOptions,
} from '@/features/harness/driver.js';
import { fillValues } from '@/features/harness/fill-values.js';
import { openFillValues, type FillValueStore } from '@/memory/project/dir/fill-value-store.js';
import {
  ANTHROPIC_DRIVER_NAME,
  CUSTOM_DRIVER_NAME,
  DRIVER_NAMES,
  JEV_DRIVER_NAME,
  OPENAI_DRIVER_NAME,
  SERVER_DRIVER,
} from '@/features/harness/drivers.js';
import { jevDriver, jevOptionsFromEnv, type DrivePlanStep } from '@/features/harness/jev-driver.js';
import { buildDomainModel } from '@/judgement/domain/domain-model.js';
import { readContract } from '@/memory/project/dir/reticle-dir.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { buildHarnessPlan, planAsText, type HarnessPlan } from './harness-plan.js';
import {
  openAiDriver,
  openAiOptionsFromEnv,
  type OpenAiDriverOptions,
} from '@/features/harness/openai-driver.js';
import { fetchPlatformConfig, type ConfigFetch } from '@/features/harness/platform-config.js';
import {
  DEFAULT_MAX_STEPS,
  runHarness,
  type HarnessResult,
  type HarnessToolset,
  type ModelDriver,
  type ToolOutcome,
} from '@/features/harness/harness.js';
import { reticleToolset } from './harness-toolset.js';
import { checkGoals, goalsIn, type GoalCheck } from '@/features/harness/goals.js';
import { secretEnvKey } from '@/language/flows/flows.js';

export interface ExploreOptions {
  /** Who to be, or what to accomplish. Appended to the standing instruction. */
  focus?: string;
  /** Texts the drive must leave on the page. Default: whatever `focus` quoted. See goals.ts. */
  goals?: readonly string[];
  /** Pinned tab, when the app has more than one connected. */
  sessionId?: string;
  /** Hard ceiling on model turns. Bounds cost, not value — the drive is usable however it ends. */
  maxSteps?: number;
  /**
   * Which driver to use for THIS drive, overriding the environment.
   *
   * Per-call rather than only per-daemon because the question people actually have is comparative —
   * "is the cheap driver good enough for my app?" — and answering it with an environment variable
   * means restarting the daemon between arms, which is exactly the setup that let a stale daemon
   * answer three runs of our own benchmark with one configuration.
   */
  driverName?: string;
  /** Injected for tests, and for anyone driving with a model this repo does not ship a binding for. */
  driver?: ModelDriver;
  /**
   * Skip asking the platform which driver this project prefers.
   *
   * Set by tests and by callers that have already decided. Not a user-facing switch: naming a
   * driver explicitly already skips the lookup, which is the only reason anybody would want to.
   */
  skipPlatformConfig?: boolean;
  /**
   * The GET that asks the platform what this project wants. Injected ONLY by tests.
   *
   * It exists because the two things this answer decides — a driver preference and whether the drive
   * may happen at all — were both unreachable without a network, and the refusal test that was
   * supposed to cover the OFF switch was asserting on a path where the platform is never asked.
   */
  configFetch?: ConfigFetch;
}

export interface ExploreResult {
  drive: HarnessResult;
  /** What the drive set out to do, read from `.reticle` before it started. */
  plan: HarnessPlan;
  /** Flows that exist now and did not before — the part of a drive that is worth paying for twice. */
  savedFlows: readonly string[];
  /** Of the saved and rewritten flows, the ones with no step that checks anything. */
  unverifiedFlows: readonly string[];
  /**
   * Flows that already existed and were written again by this drive.
   *
   * Split from `savedFlows` because the before/after name diff cannot see a rewrite, and read on its
   * own it reported a drive that saved a perfectly good ten-step flow as having saved nothing — over
   * which the caller was told "nothing is proved and nothing will replay". That sentence was false,
   * and a false "nothing was verified" is the same class of mistake as a false "everything passed":
   * the product exists to stop a drive lying about its own outcome, including to us.
   *
   * It happens on any SECOND drive, because a drive that covers the same app records the same
   * journeys under the same names — so this is the ordinary case, not the corner one.
   */
  rewroteFlows: readonly string[];
  /** One verdict per goal, checked by the harness after the drive rather than taken on its word. */
  goals: readonly GoalCheck[];
  /** The persona plan and how each persona ended, when the platform proposed the personas. */
  planLines?: readonly string[];
  /**
   * Which driver actually drove.
   *
   * Reported rather than re-derived by the caller. A second copy of "which driver would be chosen"
   * is a copy that can disagree with the one that chose, and the whole point of naming a driver is
   * to attribute a result to it — a comparison that mislabels its own arms is worse than no
   * comparison. `custom` is an injected driver, which is neither of ours to name.
   */
  driverName: string;
}

/**
 * Why the harness is unavailable, phrased as the way to make it available.
 *
 * A missing key is a configuration fact, not a fault, and the sentence a user reads has to tell them
 * the one thing to do about it. Named here because both the CLI and the honest no-flows refusal
 * print it, and two copies of this sentence would drift.
 */
export const MSG_NO_HARNESS_KEY =
  `No model configured to drive the app: set ${ReticleEnv.HARNESS_KEY}, or run \`reticle link\` and ` +
  `set ${ReticleEnv.CLOUD_KEY}, to let Reticle explore it for you. Without either, flows are ` +
  `recorded by your own coding agent through the MCP tools.`;

/** Asked for Jev specifically and it is not configured. Distinct from having no model at all. */
export const MSG_NO_JEV_KEY =
  `The \`${JEV_DRIVER_NAME}\` driver was asked for but is not configured: set ` +
  `${ReticleEnv.HARNESS_JEV_KEY}, or run \`reticle link\` and set ${ReticleEnv.CLOUD_KEY}. ` +
  `Refusing rather than quietly driving with another model, which would misattribute the result.`;

/** Asked for OpenAI specifically and it is not configured. Never substituted, same as Jev. */
export const MSG_NO_OPENAI_KEY =
  `The \`${OPENAI_DRIVER_NAME}\` driver was asked for but is not configured: set ` +
  `${ReticleEnv.HARNESS_OPENAI_KEY}, or run \`reticle link\` and set ${ReticleEnv.CLOUD_KEY}. ` +
  `Refusing rather than quietly driving with another model, which would misattribute the result.`;

const msgUnknownDriver = (asked: string): string =>
  `Unknown harness driver \`${asked}\`. Known drivers: ${DRIVER_NAMES.join(', ')}.`;

/**
 * The environment, plus the credential this machine already has.
 *
 * `reticle link` mints a project-scoped key and files it in `~/.reticle/credentials.json`; the CLI
 * has read it from there for as long as it has existed. The harness did not, and read only
 * `process.env` — so somebody who had signed in, linked their project and been told they were
 * connected still got "no model configured to drive the app", and the only way out was to find the
 * key in the console and export it by hand. Five manual steps to reach a feature they had already
 * finished setting up.
 *
 * Resolved into the env rather than threaded through four call sites: the drivers and the
 * preference lookup all read an env record, and giving them a completed one leaves each of them
 * exactly as simple as it was. The key precedence is the resolver's, the same as sync's and the
 * CLI's: the stored key for the link's host, else the exported one (which is how CI, with no
 * keystore, gets here). An explicitly exported HOST still wins, so a proxy is not overridden.
 *
 * The credential arrives through `deps.linkedCloud`, a port, because resolving it here would make
 * the tool surface reach into `memory/cloud` — a reach the directory guard refused, correctly.
 */
export async function withLinkedCredential(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  try {
    const linked = await deps.linkedCloud?.();
    if (linked === undefined || null === linked) return env;
    return {
      ...env,
      [ReticleEnv.API_KEY]: linked.apiKey,
      [ReticleEnv.CLOUD_URL]: cloudUrlFrom(env) ?? linked.url,
    };
  } catch {
    // A credential store that cannot be read is "not linked", not an error. The harness is optional
    // and its absence is a routine answer; a drive must never fail because a JSON file was odd.
    return env;
  }
}

/** Is there a model the harness can drive with? A read, because "not configured" is not a failure. */
export function harnessAvailable(env: Record<string, string | undefined>): boolean {
  return (
    harnessOptionsFromEnv(env) !== undefined ||
    jevOptionsFromEnv(env) !== undefined ||
    openAiOptionsFromEnv(env) !== undefined
  );
}

/**
 * Read the step ceiling out of the environment.
 *
 * Exported because the number is a budget somebody pays, and a budget that can only be changed by
 * editing the source is not a budget. A value that is not a positive number is IGNORED rather than
 * treated as zero: a typo that silently drove nothing would report a clean-looking run over an app
 * nobody touched.
 */
export function maxStepsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[ReticleEnv.HARNESS_MAX_STEPS];
  if (raw === undefined) return DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STEPS;
}

/**
 * Drive a connected app with a model, through Reticle's own tools.
 *
 * The flow list is read before and after rather than taken from the model's word for it. A model
 * that says it saved a flow and did not is the same false green as an app that says it saved a
 * record and did not — and this product does not get to make that mistake about its own work.
 */
export async function exploreApp(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions = {},
): Promise<ExploreResult> {
  const refusal = await refusedByPlatform(env, options);
  if (refusal !== undefined) throw new Error(refusal);
  // The platform's Harness with no persona named: it proposes the people worth being, and each is
  // driven in turn. Narrated into the HUD's Agent Log as a plan, so the person watching sees which
  // journey is running and which proved.
  const platform = serverOptionsFromEnv(env);
  if (
    options.focus === undefined &&
    platform !== undefined &&
    SERVER_DRIVER === (options.driverName ?? env[ReticleEnv.HARNESS_DRIVER])
  ) {
    const about = planAsText(await readPlan(deps, options.sessionId));
    const personas = await proposePersonas(platform, about);
    if (0 < personas.length) return explorePersonas(deps, env, options, personas);
  }

  const maxSteps = options.maxSteps ?? maxStepsFromEnv(env);
  const before = new Set(await deps.flows.list());
  // `.reticle` FIRST, before the app and before anything reads a line of source. It already holds
  // every saved flow, the consequence that must hold for each, and the declared intent nobody has
  // tested — which is the whole of what a drive should be deciding against.
  const plan = await readPlan(deps, options.sessionId);
  /*
   * The fixtures this project has already paid for.
   *
   * A drive is a sequence of DECISIONS and, occasionally, one COMPOSITION: what to type into a box
   * whose label nothing can guess from. The cheap driver cannot write a string at all, so those
   * boxes used to receive the words "reticle harness". This is the seam where a generating model
   * answers instead -- for about 6% of steps, once per label, and never again on any later drive,
   * because the answer is written into `.reticle` beside the flows that use it.
   */
  const fills = await openFillValues(deps.fs, safeRoot(deps, options.sessionId));
  const requested =
    options.driverName ?? env[ReticleEnv.HARNESS_DRIVER] ?? (await preferredDriver(env, options));
  const built =
    options.driver === undefined
      ? buildDriver(env, maxSteps, plan, requested, fills, options.focus)
      : { driver: options.driver, name: CUSTOM_DRIVER_NAME };
  const driver = built.driver;

  // Every action this drive takes carries who took it, so the run it folds into is the Harness's own
  // and not mixed into the run of whichever agent shares the tab.
  const toolset = reticleToolset(deps, {
    ...pinned(options),
    drivenBy: {
      harness: randomUUID(),
      driver: built.name,
      ...(options.focus === undefined ? {} : { persona: options.focus }),
    },
  });
  const drive = await runHarness(driver, toolset, {
    maxSteps,
    // The plan rides in as standing instruction, so it is in front of the model on every turn
    // rather than remembered from a first one. `focus` is the caller's own words and goes last:
    // somebody who named a journey meant that journey, whatever the project's backlog says.
    focus: [
      planAsText(plan),
      ...(options.focus === undefined ? [] : [`Focus: ${options.focus}`]),
    ].join('\n\n'),
  });

  // Written once, after the drive, whatever the drive did: a run that broke still learned what it
  // learned, and the next one should not pay for it again.
  await fills.flush();

  // MANDATORY, and deliberately outside the loop. A drive that runs out of budget mid-journey, or
  // breaks, or whose model simply stops asking for tools, leaves a recording open and everything it
  // drove unsaved — work paid for and thrown away. Saving is not a decision any model gets to make
  // and not something a step budget gets to cut off, so it happens here, after the loop, always.
  await bankOpenRecording(toolset, drive, options.focus);
  const goals = await checkGoals(
    (name, args) => toolset.invoke(name, args),
    options.goals ?? goalsIn(options.focus),
  );

  const after = await deps.flows.list();
  const reconciled = reconcileFlows(before, after, drive.toolCalls);
  if (options.focus !== undefined) {
    await recordPersona(
      deps,
      [...reconciled.savedFlows, ...reconciled.rewroteFlows],
      options.focus,
    );
  }
  const unverifiedFlows = await flowsThatCheckNothing(deps, [
    ...reconciled.savedFlows,
    ...reconciled.rewroteFlows,
  ]);
  return { drive, plan, driverName: built.name, ...reconciled, unverifiedFlows, goals };
}

/** Drive each proposed persona in turn, and fold their results into one answer. */
async function explorePersonas(
  deps: ToolDeps,
  env: Record<string, string | undefined>,
  options: ExploreOptions,
  personas: readonly Persona[],
): Promise<ExploreResult> {
  const narrate = (text: string): void => {
    try {
      deps.sessions.resolve(options.sessionId).pushNarration(text);
    } catch {
      /* nobody is watching: the plan still runs */
    }
  };
  narrate(`Plan · ${String(personas.length)} personas: ${personas.map((p) => p.name).join(', ')}`);
  const results: ExploreResult[] = [];
  const lines: string[] = [];
  for (const persona of personas) {
    narrate(`▸ ${persona.name}: ${persona.journey}`);
    const result = await exploreApp(deps, env, {
      ...options,
      focus: `${persona.name}: ${persona.journey}`,
    });
    results.push(result);
    const mark = result.drive.proved ? '✓' : '○';
    const line = `${mark} ${persona.name} — ${result.drive.proved ? 'proved' : 'not proved'} (${result.drive.stopReason})`;
    lines.push(line);
    narrate(line);
  }
  const last = results[results.length - 1] ?? (await exploreApp(deps, env, { ...options }));
  const sum = (pick: (r: ExploreResult) => number): number =>
    results.reduce((n, r) => n + pick(r), 0);
  return {
    ...last,
    drive: {
      ...last.drive,
      steps: sum((r) => r.drive.steps),
      proved: results.some((r) => r.drive.proved),
      summary: [`Plan · ${String(personas.length)} personas`, ...lines, last.drive.summary].join(
        '\n',
      ),
      usage: {
        input: sum((r) => r.drive.usage.input),
        output: sum((r) => r.drive.usage.output),
        cacheRead: sum((r) => r.drive.usage.cacheRead),
        cacheWrite: sum((r) => r.drive.usage.cacheWrite),
      },
    },
    savedFlows: [...new Set(results.flatMap((r) => r.savedFlows))],
    rewroteFlows: [...new Set(results.flatMap((r) => r.rewroteFlows))],
    unverifiedFlows: [...new Set(results.flatMap((r) => r.unverifiedFlows))],
    goals: results.flatMap((r) => r.goals),
    planLines: [`Plan · ${String(personas.length)} personas`, ...lines],
  };
}

/**
 * Write the persona onto every flow the drive saved or rewrote without an intent.
 *
 * Whichever driver saved it, and in whatever words: the cheap driver's own teardown saved its flow
 * with no intent at all, so a replay could never say which journey it was meant to prove. A flow
 * that already carries an intent keeps it. Best effort: a flow that cannot be read or rewritten is
 * still a saved flow.
 */
async function recordPersona(
  deps: ToolDeps,
  names: readonly string[],
  persona: string,
): Promise<void> {
  const intent = persona.trim();
  if (0 === intent.length) return;
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok || (loaded.value.intent ?? '').length > 0) continue;
      // Its own project: without it the store files a flat duplicate beside the original.
      const project = loaded.value.projectId;
      await deps.flows.saveFlow(
        { ...loaded.value, intent },
        project === undefined ? undefined : asProjectId(project),
      );
    } catch {
      /* the flow stays as it was saved */
    }
  }
}

/**
 * The saved flows with no step that asserts a consequence.
 *
 * Such a flow replays as "verified nothing": it clicks through the journey and would pass with the
 * feature broken. Named so the drive's report does not count it as evidence. A flow that cannot be
 * read is left out rather than guessed at.
 */
async function flowsThatCheckNothing(
  deps: ToolDeps,
  names: readonly string[],
): Promise<readonly string[]> {
  const empty: string[] = [];
  for (const name of names) {
    try {
      const loaded = await deps.flows.load(name);
      if (!loaded.ok) continue;
      if (!loaded.value.steps.some((step) => step.expect !== undefined)) empty.push(name);
    } catch {
      /* unreadable is not the same as empty */
    }
  }
  return empty;
}

/**
 * What a drive actually left behind, split into flows that are NEW and flows it wrote over.
 *
 * Pure, and exported, because it is the part that was wrong and the part worth pinning. The
 * integration around it — a real toolset dispatching a real save — is covered by driving a real app;
 * what a test can usefully hold still is the reconciliation itself.
 *
 * A rewrite is only counted when the drive claims the save AND the store lists the name afterwards.
 * The claim on its own is not evidence, which is the rule this function existed to keep: a model
 * that says it saved something it did not must not be believed. Requiring both is what lets a
 * rewrite be seen at all, since a name that was already there cannot show up in a before/after diff.
 */
export function reconcileFlows(
  before: ReadonlySet<string>,
  after: readonly string[],
  toolCalls: readonly {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
    isError: boolean;
  }[],
): { savedFlows: readonly string[]; rewroteFlows: readonly string[] } {
  const present = new Set(after);
  const claimed = toolCalls
    .filter((call) => ReticleTool.FLOW_SAVE === call.name && !call.isError)
    .map((call) => {
      // The flow's filename is `saveAs` when given, and the recording's name otherwise. Read from
      // the result first, which is what the store actually wrote, and fall back to the request.
      const result = asRecord(call.result)['name'];
      if ('string' === typeof result) return result;
      const args = asRecord(call.args);
      const saveAs = args['saveAs'];
      const flowName = args['flowName'];
      if ('string' === typeof saveAs) return saveAs;
      return 'string' === typeof flowName ? flowName : undefined;
    })
    .filter((name): name is string => name !== undefined && present.has(name));

  return {
    savedFlows: after.filter((name) => !before.has(name)),
    rewroteFlows: [...new Set(claimed.filter((name) => before.has(name)))],
  };
}

/**
 * The driver this project chose on the platform, if it chose one, we can reach it, and we have it.
 *
 * Only asked when nobody has been explicit, so the cost is paid exactly once per drive and never on
 * a path where it could not change the answer. An unreachable platform returns undefined and the
 * environment decides, exactly as it did before this lookup existed.
 *
 * A preference naming a driver this build does not have is IGNORED rather than refused, and that
 * asymmetry with the per-call argument is deliberate. The platform offers providers this daemon may
 * be too old to know about — it already offers `openai`, which has no binding here — so a stored
 * preference is a statement about the account, not an instruction for this drive, and a daemon that
 * refused to run because a web UI knew one more word than it does would be broken by its own
 * upgrade cycle. Naming a driver in the CALL is an instruction, and an unknown one is still an
 * error there.
 *
 * It is not a silent substitution either way: the result reports the driver that actually drove.
 */
async function preferredDriver(
  env: Record<string, string | undefined>,
  options: ExploreOptions,
): Promise<string | undefined> {
  if (true === options.skipPlatformConfig) return undefined;
  return knownDriver((await platformConfig(env, options))?.provider);
}

/**
 * What a person said about autonomous driving on the platform, honoured here.
 *
 * The switch existed, persisted and round-tripped, and the daemon read it and threw it away — so
 * turning the harness OFF changed a value in a database and nothing else. A control that does not
 * control anything is worse than no control: somebody turns it off, watches Reticle drive their app
 * anyway, and now correctly distrusts every other switch in the product.
 *
 * Absent means ON. The platform's own default is on, and a machine that cannot reach the platform —
 * offline, CI, no link — must not silently lose a feature it was never told to stop using.
 */
export const MSG_HARNESS_DISABLED =
  'Autonomous driving is turned OFF for this project. Turn it back on in the Reticle dashboard ' +
  '(Settings → Verification model), or drive the app yourself through the MCP tools.';

/**
 * The other reason a drive can be refused, and it is NOT the same reason.
 *
 * A drive through the platform spends Reticle's model budget. That is free for three months and
 * included on a paid plan, and outside both it is somebody else's money being spent on nothing. The
 * message says which of the two it is and what to do, because "the harness is off" told to a person
 * who never turned anything off is a support ticket rather than an answer.
 */
export const MSG_HARNESS_UNCLAIMED =
  'This workspace has no Harness plan, so autonomous driving would run on Reticle’s model budget ' +
  'with nothing paying for it. Start a trial or plan in the Reticle dashboard (Settings → Billing), ' +
  'or export a model API key of your own and drive with that.';

/** The platform could not be asked, and the drive would spend Reticle's budget without its yes. */
export const MSG_HARNESS_UNCONFIRMED =
  'Could not confirm Harness access with the Reticle platform, so the drive did not start: it would ' +
  'run on Reticle’s model budget unchecked. Try again in a moment, or export a model API key of ' +
  'your own and drive with that.';

/** The platform holds no key for this project's model, so a drive through it would fail mid-run. */
export const MSG_HARNESS_NO_PROVIDER =
  'The Reticle platform has no model ready for this project yet, so the drive did not start. Check ' +
  'Settings → Projects → Verification in the dashboard, or export a model API key of your own.';

/**
 * Whether a drive would be paid for by the person asking for it.
 *
 * Entitlement gates OUR spend, so it has no business stopping somebody who brought their own key:
 * their harness costs us nothing whether they ever claim anything or not. Reading the same options
 * the drivers read keeps the two answers from drifting apart.
 */
function ownsAModelKey(env: Record<string, string | undefined>): boolean {
  // The DIRECT variables only. Every driver also accepts the platform key as a fallback, so asking
  // `jevOptionsFromEnv` here would answer "they have a key" for exactly the person whose drive would
  // be billed to us — which is the one case this gate exists for.
  return [ReticleEnv.HARNESS_KEY, ReticleEnv.HARNESS_JEV_KEY, ReticleEnv.HARNESS_OPENAI_KEY].some(
    (name) => {
      const value = env[name];
      return value !== undefined && 0 < value.length;
    },
  );
}

/** One read, however many questions are asked of the answer. */
function platformConfig(env: Record<string, string | undefined>, options: ExploreOptions) {
  return options.configFetch === undefined
    ? fetchPlatformConfig(env)
    : fetchPlatformConfig(env, options.configFetch);
}

/**
 * The reason this drive must not start, or `undefined` to go ahead.
 *
 * A drive on somebody's OWN model key never waits on the platform beyond the off switch: their key,
 * their spend. A drive through the platform proxy bills Reticle, and that one needs a confirmed yes
 * — enabled, entitled, and a model ready. It used to fail open: `fetchPlatformConfig` answers
 * `undefined` on a network error, a non-2xx, a body that does not parse, or a two-second timeout,
 * and all four read as "carry on", so a slow second on a settings endpoint let an unentitled
 * workspace drive on Reticle's budget. Now the same silence refuses with a message that says to
 * retry or bring a key. Fields an older platform omits still default to yes inside
 * `fetchPlatformConfig`; only an answer that never arrived is a no.
 */
async function refusedByPlatform(
  env: Record<string, string | undefined>,
  options: ExploreOptions,
): Promise<string | undefined> {
  if (true === options.skipPlatformConfig) return undefined;
  const config = await platformConfig(env, options);
  if (config !== undefined && !config.harnessEnabled) return MSG_HARNESS_DISABLED;
  // Their key, their spend: nothing below is any of our business.
  if (ownsAModelKey(env)) return undefined;
  // No platform key either: there is no budget to protect, and the driver says what is missing.
  const platformKey = env[ReticleEnv.API_KEY];
  if (platformKey === undefined || 0 === platformKey.length) return undefined;
  // From here the drive bills Reticle, so it needs a confirmed yes, not the absence of a no.
  if (config === undefined) return MSG_HARNESS_UNCONFIRMED;
  if (!config.harnessEntitled) return MSG_HARNESS_UNCLAIMED;
  // The platform's own Harness (the default here) uses the platform's model and refuses for itself;
  // the provider check is for a LOCAL driver asked for by name that would spend through the proxy.
  const asked = options.driverName ?? env[ReticleEnv.HARNESS_DRIVER] ?? config.provider;
  if (SERVER_DRIVER !== asked && !config.providerReady) return MSG_HARNESS_NO_PROVIDER;
  return undefined;
}

/**
 * A stored preference, kept only if this build can actually honour it.
 *
 * Exported because it is the whole of the asymmetry with the per-call argument, and the asymmetry
 * is the part somebody will later think is a bug.
 */
export function knownDriver(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  return DRIVER_NAMES.some((name) => name === provider) ? provider : undefined;
}

/**
 * Close and save whatever recording the drive left open.
 *
 * The driver reserves turns for its own teardown, which covers the ordinary ending. It does NOT
 * cover a drive that broke, or one whose model went quiet, or one cut off by a budget the caller
 * shortened — and in every one of those the app really was driven and the record of it is thrown
 * away. Measured before this existed: a 24-step journey through a real dashboard, saved nothing.
 *
 * Failures are swallowed on purpose. This is a last chance, not a checkpoint: if the recording was
 * already closed the stop is refused and there is nothing to do, and a drive must not fail at the
 * finish line because the thing it was trying to rescue did not need rescuing.
 */
/**
 * What a banked recording says it was for: the persona the caller named, when there was one.
 *
 * It used to be "Autonomous drive of X, banked after the run ended" whatever the caller asked for,
 * so a replay could never say which journey the flow was meant to prove.
 */
export function bankedIntent(persona: string | undefined, open: string): string {
  const named = persona?.trim();
  return named !== undefined && 0 < named.length
    ? named
    : `Autonomous drive of ${open}, banked after the run ended.`;
}

async function bankOpenRecording(
  toolset: HarnessToolset,
  drive: HarnessResult,
  persona: string | undefined,
): Promise<void> {
  const open = openRecordingName(drive.toolCalls);
  if (open === undefined) return;
  try {
    await toolset.invoke(ReticleTool.RECORD, { action: 'stop', recordingName: open });
    await toolset.invoke(ReticleTool.FLOW_SAVE, {
      flowName: open,
      intent: bankedIntent(persona, open),
    });
  } catch {
    /* last chance, not a checkpoint */
  }
}

/** The recording started and never stopped, if there is one. Exported because it is the decision. */
export function openRecordingName(toolCalls: readonly ToolOutcome[]): string | undefined {
  let open: string | undefined;
  for (const call of toolCalls) {
    if (ReticleTool.RECORD !== call.name) continue;
    const args = asRecord(call.args);
    const name = args['recordingName'];
    if ('string' !== typeof name) continue;
    if ('start' === args['action'] && !call.isError) open = name;
    if ('stop' === args['action'] && name === open) open = undefined;
  }
  return open;
}

/**
 * Read the project's own record of what it does and what is proved about it.
 *
 * No browser, no model, no source. A failure here is "nothing is recorded yet", which is the
 * ordinary state of a new project and not a reason to refuse to drive — so it answers an empty
 * plan rather than throwing.
 */
async function readPlan(deps: ToolDeps, sessionId?: string): Promise<HarnessPlan> {
  try {
    const flows = [];
    for (const name of await deps.flows.list()) {
      const loaded = await deps.flows.load(name);
      if (loaded.ok) flows.push(loaded.value);
    }
    const root = sessionRoot(deps, sessionId);
    const contract = await readContract(deps.fs, root);
    const project = await projectForRoot(deps, root).read();
    return buildHarnessPlan(
      buildDomainModel(
        flows,
        contract.ok ? contract.capabilities : null,
        project.ok ? project.file.runs : [],
      ),
    );
  } catch {
    return {
      steps: [],
      summary: 'The project record could not be read; driving without a plan.',
      vocabulary: [],
    };
  }
}

/**
 * The project directory, or nothing.
 *
 * `sessionRoot` needs a session and a project to answer, and a drive can legitimately be asked for
 * before either is resolvable. Everything else that reads `.reticle` here already treats that as
 * "no project record" rather than as a failure; the fixtures file is no different, and a throw on
 * this path would turn a missing directory into a refused drive.
 */
function safeRoot(deps: ToolDeps, sessionId?: string): string | undefined {
  try {
    return sessionRoot(deps, sessionId);
  } catch {
    return undefined;
  }
}

function pinned(options: ExploreOptions): { sessionId?: string } {
  return options.sessionId === undefined ? {} : { sessionId: options.sessionId };
}

/**
 * Pick the driver.
 *
 * The Anthropic driver stays the default, and an explicit `RETICLE_HARNESS_DRIVER=jev` is the only
 * thing that moves off it when both are configured — a driver change is a change in how the app gets
 * driven, and inferring one from which key happens to be exported would swap it under people who
 * merely linked their account.
 *
 * The fall-through is the other direction and is not a preference: with no Anthropic key and a
 * platform key present, Jev is not the cheaper option, it is the only one. Choosing it there is what
 * makes the harness work for somebody who never had a model API key of their own, which is most
 * people — and the reason this driver is worth having at all.
 */
function buildDriver(
  env: Record<string, string | undefined>,
  maxSteps: number,
  plan: HarnessPlan,
  requested?: string,
  fills?: FillValueStore,
  persona?: string,
): { driver: ModelDriver; name: string } {
  const local = (): { driver: ModelDriver; name: string } =>
    buildLocalDriver(env, maxSteps, plan, requested, fills);
  // The platform's Harness, when asked for by name or when the platform names it as this project's
  // driver (the platform's config is the rollout switch). Asked for, it must be configured: never a
  // quiet substitution.
  if (SERVER_DRIVER !== requested) return local();
  const platform = serverOptionsFromEnv(env);
  if (platform === undefined) throw new Error(MSG_NO_HARNESS_KEY);
  return {
    driver: serverDriver({
      ...platform,
      ...(persona === undefined ? {} : { persona }),
      plan: planAsText(plan),
      maxSteps,
    }),
    name: SERVER_DRIVER,
  };
}

function buildLocalDriver(
  env: Record<string, string | undefined>,
  maxSteps: number,
  plan: HarnessPlan,
  requested?: string,
  fills?: FillValueStore,
): { driver: ModelDriver; name: string } {
  // The two halves of what `.reticle` knows, handed to the one driver that can use both: what is
  // worth doing, and the names the app uses for what it does. The second is what lets a declared
  // consequence be SAVED rather than merely proved; see `consequencesFor`.
  const fromReticle = {
    plan: plan.steps as readonly DrivePlanStep[],
    vocabulary: plan.vocabulary,
    /*
     * Generation is offered ONLY when a generating model is already configured, and it stays out of
     * the per-turn loop either way: put a text model on every turn and you pay its per-turn tax on
     * the 94% of steps that are clicks, which is the entire cost the cheap driver exists to avoid.
     * With no such key the label heuristic answers, exactly as it did before this existed.
     */
    fillValue: fillValues({
      secret: (label) => env[secretEnvKey(label)],
      ...(fills === undefined ? {} : { cache: fills }),
      // GPT first: a linked machine reaches it through the platform with no key of its own.
      ...(openAiOptionsFromEnv(env) === undefined
        ? {}
        : { openai: openAiOptionsFromEnv(env) as OpenAiDriverOptions }),
      ...(harnessOptionsFromEnv(env) === undefined
        ? {}
        : { generator: harnessOptionsFromEnv(env) as HarnessDriverOptions }),
    }),
  };
  const jev = jevOptionsFromEnv(env);
  const anthropic = harnessOptionsFromEnv(env);
  const asked = requested;

  // A driver that was ASKED for and is not configured is an error, never a substitution. Quietly
  // falling back would make every comparison between two drivers a possible lie about which one
  // produced the result — and comparing them is the main reason anyone names one.
  if (JEV_DRIVER_NAME === asked) {
    if (jev === undefined) throw new Error(MSG_NO_JEV_KEY);
    // The Jev driver is told the budget because it has a teardown to reach; the Anthropic driver is
    // not, because it calls `finish` itself and being handed a number it did not ask for is how a
    // second copy of the budget starts drifting from the loop's.
    return { driver: jevDriver({ ...jev, maxSteps, ...fromReticle }), name: JEV_DRIVER_NAME };
  }
  if (ANTHROPIC_DRIVER_NAME === asked) {
    if (anthropic === undefined) throw new Error(MSG_NO_HARNESS_KEY);
    return { driver: harnessDriver(anthropic), name: ANTHROPIC_DRIVER_NAME };
  }
  if (OPENAI_DRIVER_NAME === asked) {
    const openai = openAiOptionsFromEnv(env);
    if (openai === undefined) throw new Error(MSG_NO_OPENAI_KEY);
    return { driver: openAiDriver(openai), name: OPENAI_DRIVER_NAME };
  }
  if (asked !== undefined && 0 < asked.length) throw new Error(msgUnknownDriver(asked));

  if (anthropic !== undefined)
    return { driver: harnessDriver(anthropic), name: ANTHROPIC_DRIVER_NAME };
  if (jev !== undefined)
    return { driver: jevDriver({ ...jev, maxSteps, ...fromReticle }), name: JEV_DRIVER_NAME };
  throw new Error(MSG_NO_HARNESS_KEY);
}
