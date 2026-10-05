/**
 * The goals a drive was asked to prove, and whether it did.
 *
 * A drive asked to "check that "Ada Lovelace" and "Grace Hopper" are listed" replayed old journeys,
 * dismissed a reminder and reported `finished` without looking for either name (#1316). The driver's
 * word for it is not evidence, so after every drive the harness checks each goal itself, with the
 * same assert any agent would make, and reports one verdict per goal.
 */
import { PredicateKind, ReticleTool, Verified, asRecord } from '@reticlehq/core';

/** More than this and the persona is a document, not a set of goals. */
const MAX_GOALS = 10;
const MAX_GOAL_LENGTH = 200;

/** A string the persona quoted: "straight" or “curly”. Single quotes are apostrophes too often. */
const QUOTED = /"([^"\n]{1,200})"|“([^”\n]{1,200})”/g;

export interface GoalCheck {
  /** The text that had to be on the page. */
  text: string;
  /** The engine's verdict on it: only `yes` is proved. */
  verified: string;
}

/** The observable goals in a persona: whatever it quoted. */
export function goalsIn(persona: string | undefined): string[] {
  if (persona === undefined) return [];
  const found = [...persona.matchAll(QUOTED)].map((m) => (m[1] ?? m[2] ?? '').trim());
  return [...new Set(found.filter((g) => 0 < g.length))].slice(0, MAX_GOALS);
}

/** Assert each goal on the page the drive ended on. A check that cannot run is `unknown`, never skipped. */
export async function checkGoals(
  invoke: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  goals: readonly string[],
): Promise<GoalCheck[]> {
  const checks: GoalCheck[] = [];
  for (const raw of goals.slice(0, MAX_GOALS)) {
    const text = raw.trim().slice(0, MAX_GOAL_LENGTH);
    if (0 === text.length) continue;
    let verified: string = Verified.UNKNOWN;
    try {
      const result = asRecord(
        await invoke(ReticleTool.ASSERT, {
          predicate: { kind: PredicateKind.TEXT, contains: text },
        }),
      );
      if ('string' === typeof result['verified']) verified = result['verified'];
    } catch {
      /* stays unknown: the goal was not proved */
    }
    checks.push({ text, verified });
  }
  return checks;
}

/** One line naming the goals the drive did not prove, or undefined when it proved them all. */
export function unprovedGoals(checks: readonly GoalCheck[]): string | undefined {
  const missed = checks.filter((c) => Verified.YES !== c.verified);
  if (0 === missed.length) return undefined;
  return (
    `Not proved: ${missed.map((c) => `"${c.text}" (${c.verified})`).join(', ')}. ` +
    'The drive did not finish the job it was given, whatever its own account says.'
  );
}
