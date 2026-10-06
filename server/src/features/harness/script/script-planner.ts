/**
 * The Harness's drive plan, from what the project already knows. No model, no browser.
 *
 * Saved flows become replay journeys (deterministic, cheap) in the order they need each other.
 * Flows that start with the same steps become ONE journey that drives the shared part once, marks
 * it as a checkpoint, and branches: each other flow re-enters the checkpoint and continues from
 * there. Personas, the user's declared request and the intents nobody has proved become open
 * journeys the model drives, after the flow everything else needs (usually sign-in).
 *
 * Each journey nothing else needs gets its own lane, holding what it needs in order, so lanes can
 * run side by side in separate browser contexts. A prerequisite that COMMITS something (a payment,
 * an email) runs in one lane only; later lanes wait on it instead of committing it a second time.
 */
import { DriveScriptSchema, ScriptSource, ScriptStepKind } from '@reticlehq/core/artifacts';
import type { DriveScript, Journey, Lane } from '@reticlehq/core/artifacts';
import { StepEffect, type FlowFile, type FlowStep } from '@reticlehq/core';

export interface PlannerInput {
  /** Every saved flow, loaded. */
  flows: readonly FlowFile[];
  /** The flows worth replaying, most important first (the Harness plan's replay steps). */
  replay: readonly string[];
  personas: readonly { name: string; journey: string }[];
  /** What the project still owes, in its own words: the declared request and open intents. */
  goals: readonly string[];
  /** Declared but untested behaviour, as the Harness plan words it. */
  gaps: readonly string[];
}

/** Two flows share a checkpoint only when at least this many leading steps are the same. */
const MIN_SHARED_STEPS = 2;
const MAX_GOALS = 3;
const MAX_GAPS_IN_GOAL = 6;
const EXPLORE_GOAL = 'Find out what this app does for its users and prove its main journey.';

export function planScript(input: PlannerInput): DriveScript {
  const byName = new Map(input.flows.map((flow) => [flow.name, flow]));
  const ordered = withPrerequisites(input.replay, byName);
  const needed = new Set(ordered.flatMap((name) => byName.get(name)?.needs ?? []));
  const journeys: Journey[] = [];
  const merged = new Set<string>();

  for (const name of ordered) {
    const flow = byName.get(name);
    if (flow === undefined || merged.has(name)) continue;
    const persona = personaOf(flow, input.personas);
    const dependsOn = (flow.needs ?? []).filter((need) => ordered.includes(need));
    const group = needed.has(name) ? [] : branchGroup(flow, ordered, byName, needed, merged);
    if (0 === group.length) {
      journeys.push({
        id: name,
        title: titleOf(flow),
        ...(persona === undefined ? {} : { persona }),
        dependsOn,
        steps: [{ kind: ScriptStepKind.REPLAY, flow: name }],
      });
      continue;
    }
    const at = Math.min(
      ...group.map((other) => sharedPrefix(flow.steps, other.steps)),
      ...[flow, ...group].map((each) => each.steps.length - 1),
    );
    for (const other of group) merged.add(other.name);
    journeys.push({
      id: name,
      title: `${titleOf(flow)}, and ${String(group.length)} more from the same point`,
      ...(persona === undefined ? {} : { persona }),
      dependsOn,
      steps: [
        { kind: ScriptStepKind.REPLAY, flow: name, to: at },
        { kind: ScriptStepKind.CHECKPOINT, id: 'shared', reenter: { flow: name, to: at } },
        {
          kind: ScriptStepKind.BRANCH,
          at: 'shared',
          cases: [flow, ...group].map((each) => ({
            label: each.name,
            steps: [{ kind: ScriptStepKind.REPLAY, flow: each.name, at }],
          })),
        },
      ],
    });
  }

  // The flow every other one needs, when there is exactly one: open journeys start after it too.
  const roots = ordered.filter(
    (name) => needed.has(name) && 0 === (byName.get(name)?.needs ?? []).length,
  );
  const after = 1 === roots.length ? roots : [];
  const open = (id: string, title: string, goal: string, persona?: string): Journey => ({
    id,
    title,
    ...(persona === undefined ? {} : { persona }),
    dependsOn: after,
    steps: [{ kind: ScriptStepKind.ACT, goal }],
  });
  input.personas.forEach((persona, index) => {
    journeys.push(
      open(
        `persona-${String(index + 1)}`,
        persona.journey,
        `${persona.name}: ${persona.journey}`,
        persona.name,
      ),
    );
  });
  input.goals.slice(0, MAX_GOALS).forEach((goal, index) => {
    journeys.push(open(`goal-${String(index + 1)}`, goal, goal));
  });
  if (0 === input.personas.length && 0 === input.goals.length && 0 < input.gaps.length) {
    const list = input.gaps.slice(0, MAX_GAPS_IN_GOAL).join('\n- ');
    journeys.push(
      open(
        'gaps',
        'Cover what no saved flow proves',
        `Drive what no saved flow proves yet:\n- ${list}`,
      ),
    );
  }
  if (0 === journeys.length) journeys.push(open('explore', 'Explore the app', EXPLORE_GOAL));

  return DriveScriptSchema.parse({
    version: 1,
    source: ScriptSource.LOCAL,
    personas: input.personas,
    journeys,
    lanes: lanesFor(journeys, byName),
  });
}

/** The requested flows and everything they need, prerequisites first; unknown names dropped. */
function withPrerequisites(names: readonly string[], byName: Map<string, FlowFile>): string[] {
  const out: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (out.includes(name) || visiting.has(name)) return;
    const flow = byName.get(name);
    if (flow === undefined) return;
    visiting.add(name);
    for (const need of flow.needs ?? []) visit(need);
    visiting.delete(name);
    out.push(name);
  };
  for (const name of names) visit(name);
  return out;
}

/** Flows later in the order that start the same way as `flow`, need the same things, and commit nothing on the way. */
function branchGroup(
  flow: FlowFile,
  ordered: readonly string[],
  byName: Map<string, FlowFile>,
  needed: ReadonlySet<string>,
  merged: ReadonlySet<string>,
): FlowFile[] {
  const needs = [...(flow.needs ?? [])].sort().join('\n');
  return ordered
    .slice(ordered.indexOf(flow.name) + 1)
    .map((name) => byName.get(name))
    .filter((other): other is FlowFile => other !== undefined)
    .filter(
      (other) =>
        !needed.has(other.name) &&
        !merged.has(other.name) &&
        [...(other.needs ?? [])].sort().join('\n') === needs &&
        // Every case continues past the checkpoint, so the shared part stops before either ends.
        Math.min(
          sharedPrefix(flow.steps, other.steps),
          flow.steps.length - 1,
          other.steps.length - 1,
        ) >= MIN_SHARED_STEPS &&
        !flow.steps
          .slice(0, sharedPrefix(flow.steps, other.steps))
          .some((step) => StepEffect.COMMITS === step.effect),
    );
}

/** How many leading steps drive the same control the same way. */
function sharedPrefix(a: readonly FlowStep[], b: readonly FlowStep[]): number {
  let n = 0;
  while (n < a.length && n < b.length && sameAction(a[n], b[n])) n += 1;
  return n;
}

function sameAction(a: FlowStep | undefined, b: FlowStep | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const shape = (s: FlowStep): string =>
    JSON.stringify([s.tool, s.anchor, s.action, s.args, s.steps, s.invoke]);
  return shape(a) === shape(b);
}

function titleOf(flow: FlowFile): string {
  const intent = flow.intent?.trim();
  return intent !== undefined && 0 < intent.length ? intent : flow.name;
}

/** The persona a flow was recorded as, from the `Name: journey` intent a persona drive writes. */
function personaOf(flow: FlowFile, personas: readonly { name: string }[]): string | undefined {
  return personas.find((p) => true === flow.intent?.startsWith(`${p.name}:`))?.name;
}

/** One lane per journey nothing else needs, holding what it needs in order. */
function lanesFor(journeys: readonly Journey[], byName: Map<string, FlowFile>): Lane[] {
  const byId = new Map(journeys.map((j) => [j.id, j]));
  const required = new Set(journeys.flatMap((j) => j.dependsOn));
  const commits = (id: string): boolean =>
    true === byName.get(id)?.steps.some((step) => StepEffect.COMMITS === step.effect);
  const committed = new Set<string>();
  const lanes: Lane[] = [];
  for (const sink of journeys.filter((j) => !required.has(j.id))) {
    const chain: string[] = [];
    const visit = (id: string): void => {
      const journey = byId.get(id);
      if (journey === undefined || chain.includes(id)) return;
      for (const dep of journey.dependsOn) visit(dep);
      if (id !== sink.id && commits(id) && committed.has(id)) return;
      chain.push(id);
    };
    visit(sink.id);
    chain.filter(commits).forEach((id) => committed.add(id));
    lanes.push({ id: laneName(lanes.length), journeys: chain });
  }
  return lanes;
}

function laneName(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `L${String(index + 1)}`;
}
