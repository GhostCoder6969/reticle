---
title: Let Reticle drive
description: Hand the whole drive to a model inside the daemon, and get the flows it recorded back, so every run after the first one replays with no model in the loop.
icon: steering-wheel
---

Driving an app is the expensive part of verifying one. Every snapshot, every act result and every observation lands in your agent's context and is re-read on every turn after, and none of it is kept: the next run starts from nothing and pays again.

`reticle_verify { action: "explore" }` moves the driving into the daemon. A model there drives your app through the same tool surface your agent uses, records what it drove as saved flows, and hands back a few lines.

```jsonc
reticle_verify {
  action: "explore",
  persona: "a returning customer checking out with a saved card"
}
// → { stopReason, steps, savedFlows: ["checkout"], summary, usage }
```

From the command line, on a project with nothing recorded yet:

```bash
npx @reticlehq/server verify http://localhost:3000 --persona "an admin revoking a teammate's seat"
```

## The flows are the point

A drive costs a model. A **saved flow costs nothing to run again**: `reticle_verify { action: "flows" }` replays every one of them deterministically, with no model anywhere in the loop, and re-resolves each step's anchor and asserts its recorded consequence.

So the drive is a one-off: pay for it once, and the journeys it recorded become the regression suite every later run replays. That is why the harness is told to record as it goes, and why a drive that saved nothing is reported as having proved nothing, however long it ran.

## It replays before it drives

A drive reads `.reticle` first: every saved flow with the consequence that must still hold, and every signal and testid your app declares that no flow has ever asserted. It builds a plan from that before it opens its eyes on a page.

With no persona, anything already recorded is **replayed**, deterministically, with no model call at all, and only the gaps are driven (see the plan below). With a persona, it drives that journey and replays nothing else: the saved flows have nothing to do with the journey you named. So a second run over the same app is mostly free, and the model budget is spent on the part nobody has proved yet rather than on rediscovering what is already on disk. A replay that goes red is reported as a regression; one that DRIFTS is reported separately, because the app moved under the recording and that needs re-anchoring rather than a code change.

Every journey a drive walks is saved, whatever happens to the drive, including one that broke, ran out of budget, or whose model simply stopped asking for tools.

## With no persona, it writes a plan first

Called with no `persona`, explore writes the whole drive down before it starts, as a drive plan:

- **Journeys.** Each saved flow worth replaying, plus one open journey for each persona the platform proposes, for the request the user declared (`reticle_intent { action: "declare" }`), and for each intent nobody has proved. Replays need no model; only open journeys reach one.
- **Order.** A flow that `needs` another runs after it. An open journey runs after the flow everything else needs, usually sign-in.
- **Lanes.** Each journey nothing else needs gets a lane holding what it needs, in order. Lanes run side by side, each in its own leased browser context, four at a time. A journey that needs one from another lane waits for it, and is blocked if that journey failed. A prerequisite that commits something (a payment, an email) runs in one lane only, and the others wait on it rather than commit it twice.
- **Branches.** Flows that start with the same steps become one journey. The shared steps are driven once and marked as a checkpoint, then each flow continues from that point. Every flow after the first replays back to the checkpoint first, so none of them starts from the page the previous one left.

The plan appears at the top of the HUD's Agent Log: one row per lane, a card per journey, the running journey opened to its steps, and each card marked as it passes, fails or is blocked. The tool's answer carries one line per journey.

Two `reticle_flow_replay` arguments make the branches possible, and you can use them directly. `to` stops before a step. `at` continues at a step on the page as it is, without driving the steps before it. A part-way replay checks the steps it drove and records nothing about the flow as a whole.

## What it needs

**A model in the daemon's environment.** Any one of three, and the choice is reported back so a comparison can never mislabel its own arms:

| Variable | Driver |
| --- | --- |
| `RETICLE_API_KEY` | `jev`, against the platform's own proxy, using the key `reticle link` already wrote. No model API key of your own, and the cheap path: it answers typed questions about the page rather than generating tool calls as text. |
| `ANTHROPIC_API_KEY` | `anthropic`, which generates its calls as text. |
| `OPENAI_API_KEY` | `openai`, the same, on OpenAI. |
| `JEV_API_KEY` | `jev`, against TypeSafe directly, for anyone who holds their own key. |
| `RETICLE_API_KEY` + `driver: "server"` | `server`, the platform's Harness: the platform holds the persona and every decision, turn by turn, and this daemon executes each step against your local app. Needs a plan or trial. |

With several configured, `anthropic` is the default and `RETICLE_HARNESS_DRIVER` moves off it; with only a platform key, `jev` is the default unless the platform names `server` as the project's driver. Naming a driver that is not configured is an error, never a silent substitution.

With `driver: "server"` and no `persona`, the platform proposes four or five people worth being for your app (a first-time visitor, a power user, a keyboard user, somebody careless) and drives each in turn. Any "double-quoted text" in a persona must be on the page when the journey ends, and is checked.

**What you see.** The HUD's Agent Log marks the moment the Harness takes over ("Reticle Harness is driving") and gives its steps their own colour, so you can tell its work from your agent's. Each Harness drive is recorded as its own run, named for its journey and credited to the Harness, beside your agent's run.

A driver can also be chosen per call, as `reticle_verify { action: "explore", driver: "jev" }`. The question people actually have is comparative, and answering it with an environment variable means restarting the daemon between arms.

Three other dials, all optional:

| Variable | What it does |
| --- | --- |
| `RETICLE_HARNESS_MODEL` | The Anthropic model that drives. Defaults to a mid-tier one on purpose, for the reason below. |
| `RETICLE_HARNESS_MAX_STEPS` | Ceiling on model turns in one drive. Bounds cost, not value. |
| `RETICLE_HARNESS_BASE_URL` | A proxy or gateway instead of the default API host. |

## Two models, and what each one is for

The `jev` driver decides; it cannot write. Every choice a drive makes is a selection from candidates Reticle enumerated off the page: which element, which tool, what consequence to claim. That is why it costs a fraction of a generating model and answers in a few hundred milliseconds.

One thing in a drive is not a selection. A text field is a composition: "a business name", "a statement descriptor", "a search term that returns results" cannot be enumerated from the page. Where the field's label is enough to guess, a small table answers it. Where it is not, and a generating model is configured, that model writes the value, and nothing else.

Typing is a small minority of what a drive does: clicks and navigations are the overwhelming majority. So this is escalation rather than a second model in the loop, and a drive with no text fields never calls it at all.

What it writes is a FIXTURE, not an opinion. Generated values are saved to `.reticle/fill-values.json` and reused forever: the second drive pays nothing, a replay sends exactly what the recording sent, and a value you dislike is a line in a git-checked file you can edit rather than an argument with a model.

## Turning it off, and who pays for it

A project linked to a Reticle workspace reads two things from it before a drive starts, and honours both:

- **The switch.** Autonomous driving can be turned off per project, from the HUD's Reticle Harness switch or the dashboard (Settings → Verification model). A drive then refuses and says where to turn it back on. Switched off while a platform drive is running, the drive stops at its next turn with `stopReason: "stopped"`, keeps what it drove, and says so in the Agent Log. Everything else is unaffected, including the tools your own agent drives with.
- **Who is paying.** Driving through the platform spends Reticle's model budget, which is free for three months once claimed and included on a paid plan. Outside both, a drive is refused with the claim link rather than run on somebody else's money.

Neither applies to a drive on a model key of your own: that costs us nothing, so it is not ours to gate. A daemon that cannot reach the platform at all drives normally: an unreachable settings endpoint is not a reason to lose a feature you were never told to stop using.

## What it will not do

**It does not decide whether your app is correct.** The model chooses what to _try_; the engine decides what _happened_, from what it recorded. A model that graded its own driving would be scoring its own homework, and its verdict would be unfalsifiable. So the summary it writes is an account of what it drove, and nothing downstream grades from it.

That split is also why the default model is not the largest one available. The harness is exploring an interface and stating expectations, not reasoning about your business logic. If finding defects needed a frontier model _there_, the engine would not be doing its job.

**It really clicks.** A drive navigates, submits forms and mutates state, exactly like the crawl does. Point it at a preview or a dev environment, not production.

**It is never automatic.** `reticle verify` will not drive your app unless you ask with `--explore` or `--persona`, and it never drives a project that already has saved flows. Replaying those is the cheap path, and spending a model budget to re-discover what is already recorded would be the wrong trade.

## Give it a persona

A drive with no focus clicks around. A drive with a persona completes a journey, and a journey is what turns into a flow worth replaying:

- `"a first-time user signing up and inviting a teammate"`
- `"an admin revoking a seat, then checking the seat count"`
- `"a returning customer applying an expired discount code"`

Name the outcome, not the buttons. What breaks in real products is a chain: sign up, verify, invite, join. A chain fails at whichever link nobody walked.
