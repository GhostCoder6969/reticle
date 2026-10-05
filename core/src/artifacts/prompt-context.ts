/**
 * The prompt side of a verification: what the user asked for, relayed by the agent, and every
 * statement in it and in the agent's declared intents, classified and attributed. Daemon-side only:
 * a run carries it loosely (`context`), so it adds nothing to what a page downloads.
 */
import { z } from 'zod';

/** What a statement in the prompt context is, so a reader can tell a goal from a preference. */
export const StatementKind = {
  BUSINESS_INTENT: 'business-intent',
  ACCEPTANCE: 'acceptance-criterion',
  CONSTRAINT: 'technical-constraint',
  PREFERENCE: 'preference',
} as const;
export type StatementKind = (typeof StatementKind)[keyof typeof StatementKind];

/** Who said it. The user's words reach Reticle through the agent, so `user` means relayed verbatim. */
export const StatementSource = {
  USER: 'user',
  AGENT: 'agent',
} as const;
export type StatementSource = (typeof StatementSource)[keyof typeof StatementSource];

/** The words that make a statement each kind. Checked in this order; the first that matches wins. */
const STATEMENT_RULES: readonly { kind: StatementKind; words: RegExp }[] = [
  {
    kind: StatementKind.PREFERENCE,
    words: /\b(i (?:prefer|like|want it|would rather)|ideally|nicer|taste|style)\b/i,
  },
  {
    kind: StatementKind.CONSTRAINT,
    words:
      /\b(use|don't use|do not use|without|library|framework|api|endpoint|database|schema|typescript|react|must not import|performance|latency)\b/i,
  },
  {
    kind: StatementKind.ACCEPTANCE,
    words:
      /\b(must|should|has to|needs to|shows?|displays?|returns?|when .* then|so that|until)\b/i,
  },
];

/**
 * A statement's kind, by the words in it.
 *
 * ponytail: keyword rules, not a model. Good enough to separate "the checkout must show the total"
 * from "use the existing Button" from "I prefer it darker"; a model classifier can replace this
 * function without changing what is stored.
 */
export function classifyStatement(text: string): StatementKind {
  for (const rule of STATEMENT_RULES) if (rule.words.test(text)) return rule.kind;
  return StatementKind.BUSINESS_INTENT;
}

/** A request split into the sentences a reader would weigh one at a time. */
export function splitStatements(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => 0 < s.length);
}

/**
 * The prompt side of a verification: what the user asked for (relayed by the agent), and each
 * statement in it and in the agent's declared intents, classified and attributed.
 *
 * `shared` is the project's opt-in: without it the context stays on this machine and every upload
 * drops it. See `shareableRun`.
 */
export const PromptContextSchema = z.object({
  request: z.string().max(4000).optional(),
  statements: z
    .array(
      z.object({
        text: z.string().max(500),
        kind: z.nativeEnum(StatementKind),
        source: z.nativeEnum(StatementSource),
      }),
    )
    .max(50)
    .default([]),
  /** When the request was given, epoch ms. A run long after it is not about it. */
  at: z.number().optional(),
  shared: z.boolean().optional(),
});
export type PromptContext = z.infer<typeof PromptContextSchema>;

/** A run as it may leave this machine: its prompt context only when the project opted in. */
export function shareableRun(run: unknown): unknown {
  if ('object' !== typeof run || null === run || !('context' in run)) return run;
  const { context, ...rest } = run as { context?: { shared?: unknown } };
  return true === context?.shared ? run : rest;
}
