import { ReticleEnv } from '@reticlehq/core';
/**
 * The names of the drivers the harness can be asked for.
 *
 * A leaf module on purpose. These used to be re-exported from `harness-explore.ts`, which sits in
 * the tool surface and is reached, through the toolset and the tool table, from the very tool that
 * needs to declare them as an enum — a cycle that left the list `[undefined, undefined]` at the
 * moment zod read it, and failed inside a JSON-schema parser rather than anywhere near the cause.
 * Nothing here imports anything, so nothing can be half-initialised when it is read.
 */

/** Generates its tool calls as text, and names the journeys it records. The default. */
export const ANTHROPIC_DRIVER_NAME = 'anthropic';

/** Answers typed questions; picks from the elements on the page and cannot invent one. */
export const JEV_DRIVER_NAME = 'jev';

/** Generates its tool calls, over Chat Completions. Here so an A/B has a third arm. */
export const OPENAI_DRIVER_NAME = 'openai';

/** What a caller may name. Order is the order a reader sees them in the tool description. */
/** The platform's Harness: it decides on its side, this machine executes. See server-driver.ts. */
export const SERVER_DRIVER = 'server';

export const DRIVER_NAMES = [
  ANTHROPIC_DRIVER_NAME,
  JEV_DRIVER_NAME,
  OPENAI_DRIVER_NAME,
  SERVER_DRIVER,
] as const;

/** An injected driver: not selectable, because only a caller in-process can supply one. */
export const CUSTOM_DRIVER_NAME = 'custom';

/**
 * What a drive needs, said once for every place that tells somebody. It used to say "needs
 * ANTHROPIC_API_KEY" in three places after the platform proxy, Jev and OpenAI had all become ways in.
 */
export const EXPLORE_NEEDS =
  `Needs a Reticle Harness plan on a linked project, or your own ${ReticleEnv.HARNESS_KEY}, ` +
  `${ReticleEnv.HARNESS_JEV_KEY} or ${ReticleEnv.HARNESS_OPENAI_KEY} in the daemon environment.`;
