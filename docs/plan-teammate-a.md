# Unsaid — teammate A lane: messaging and flow

## Context

DivHacks build night, 4pm–12am. The work splits two ways: **A owns messaging and flow** (Spectrum, router, join codes, orchestrator state machine, Nessie); **B owns agents, data and screen** (Grok extraction and scoring, aggregator, venues, backroom screen). B's lane is in `plan-teammate-b.md`.

**Read this first: the architecture changed.** Hackathon credits are **Spectrum Cloud Pro, not Business**. Pro is a **shared-pool 1:1 iMessage line**; group creation and a dedicated bot-in-the-group number are **Business-only**. So Unsaid is now **DM-only** — the product does not pivot, Unsaid just stops being a group member.

Everyone texts their own line, one backend process receives all of them, and the plan fans out as individual DMs. Shared-pool numbers **may differ per person**, so never depend on one global bot phone. The source of truth is `JOIN <code>` typed into the 1:1 each person already has. The human iMessage group survives in the demo as a bulletin board that Unsaid is not in — and if someone reads the code there but never DMs Unsaid, they are simply not in the plan.

This deletes a meaningful chunk of what A was going to build.

B's lane is unaffected — none of it ever knew messaging existed — and all of it is written and passing. A's lane is currently **zero files**: `src/index.ts` is still the `create-spectrum-project` echo bot.

## What this deletes from A's original plan

- The `space.type === "group"` branch
- Mention-gating, and with it the question of how to find our own line's phone number
- `space.getMembers()`
- Posting a plan card to a group
- **The `sms:` deep link.** A deep link needs the recipient's number baked in, but every friend texts a *different* Unsaid line and the roster is unknown in advance. The creator shares a bare code instead. This also retires the `&body=` vs `?body=` question

## Spectrum API — verified against the installed package

Read out of `node_modules/@spectrum-ts/core` and `node_modules/@spectrum-ts/imessage`, so these are facts, not guesses.

| Need | How | Note |
|---|---|---|
| Who sent it? | `message.sender.id` | Canonical platform handle. The only discriminator A needs |
| Receive on every line | bare `imessage.config()` | **Do not pin `clients`.** Pinning one phone makes the app deaf to every other line |
| Multiple lines | `clients` takes one object *or an array* of `{address, token, phone}` | Multi-line is supported in code; the plan is what limits you |
| DM or group? | `space.type` is `"dm" \| "group"` | Keep a defensive `continue` on `"group"`; it should never arrive |
| Tapback in | `message.content.type === "reaction"` | How confirmation is detected. **iMessage-only** |
| Tapback out | `message.react(emoji)` | |
| Plan card effect | `effect(content, messageEffects.confetti)` from `@spectrum-ts/imessage` | Also `fireworks`, `sparkles`, `lasers`, `balloons`, `celebration`, `echo`, `heart`, `spotlight`. **iMessage-only** |
| Typing indicator | `typing` is exposed by the provider | Cheap win — show it on every phone while the agents negotiate, so the wait reads as deliberation |
| Outbound to someone not currently texting | `space.create` with an E.164 handle | **Needed for fan-out.** Pro allowlist applies: the phone must be a registered project user. See step 8 |
| Editing a sent message | **Not available.** `@spectrum-ts/core` models `edit`/`unsend`, the iMessage provider does not expose them | So a card cannot self-update. Live confirmation tracking goes on the backroom screen |
| Group membership | `space.getMembers()` | Group-only and remote-only, throws on a DM. **Moot now** |

## The flow, end to end

```
1. creator texts their own line: "dinner friday?"      ← no code exists yet
   → plan created (status: collecting), 4-char code minted
   → bot replies with the code and "share this"

2. creator pastes "text your Unsaid: JOIN K7M2" into their real human group chat
   (Unsaid is not in that group and never sees it)

3. maya texts HER line: "JOIN K7M2"  → joined
   dev  texts HIS line: "JOIN K7M2"  → joined

4. everyone answers questions in their own 1-on-1 thread, creator included
   A calls handleDM per message; B fills slots and writes the reply
   (a first-time user gets four profile questions first — handled inside handleDM)

5. creator texts "go" → status: negotiating
   B merges, filters, scores; A logs the round and picks

6. the plan card fans out — one DM per participant, on their own line

7. tapbacks arrive as reactions; the backroom screen tracks them live
```

A code is required for **joiners only**. The creator's first message is what creates the plan.

The message loop does not collect anything. It receives and dispatches; collection happens inside B's `handleDM`.

## Files

```
src/
  index.ts              entry: dispatch reactions vs text, everything is a DM
  router.ts             sender -> user -> active plan; four branches
  join.ts               createPlan, mint code, resolve code
  orchestrator/
    machine.ts          collecting -> negotiating -> proposed -> confirmed
    select.ts           best worst-case score, tiebreak on longest commute
    messages.ts         plan card copy, confirmation copy, "nothing fits"
  nessie.ts             seed customers + purchases, budget anchor line
```

B owns `contracts.ts`, `venues.ts`, `aggregator.ts`, `agent/`, `slots.ts`, `db.ts`, `backroom/`. A imports from them and never edits them.

## 1. Message loop

```ts
for await (const [space, message] of app.messages) {
  if (space.type === "group") continue;                 // defensive; should never arrive
  if (message.content.type === "reaction") { await onTapback(space, message); continue; }
  if (message.content.type === "text") await onDirectText(space, message);
}
```

## 2. Router

The discriminator is only ever *does this sender have an active plan*. Creator and joiner are the **same code path** once either is on a plan — the distinction exists nowhere except authorising `go`.

| Condition | Branch |
|---|---|
| no plan, text starts `JOIN <code>` | resolve the code, join that plan |
| no plan, anything else | create a plan, mint a code, reply with it |
| has plan, text is `go` (and sender is the creator) | state transition |
| has plan, status `negotiating`, a question is pending for this sender | `resumeNegotiation(...)` — **not** `handleDM` |
| has plan, anything else | slot-fill |

## 3. Join flow

`createPlan(creatorId)` → `planId`, a 4-character code, `status: "collecting"`, `participants: [creator]`. Reply with the share text the creator pastes into their human group chat.

Joining is `getPlanByJoinCode(code)` → append to `participants`, set the joiner's `activePlanId`. MVP rule from the shared doc: one active plan per user; a new code switches it.

**Two gotchas.** `getPlanByJoinCode` does not exist yet — see "What A needs from B". And a 4-character code reused across demo re-runs will silently join the wrong plan, so enforce uniqueness at creation or scope codes to active plans only.

## 4. Slot-filling

```ts
const store = await openStore();                        // once at startup, not per message
const { slots, missing, reply } = await handleDM({ planId, userId, text }, store);
await space.send(reply);                                // B writes the DM copy
```

**A writes zero parsing logic** — no keywords, no regex, no prompts. This is the biggest-sounding requirement and the smallest amount of A's code. Message history persistence lands *inside* `handleDM`, so A's code will not change when B adds it.

## 5. The `go` trigger

Plain `go` is enough; there is no mention to gate on in a DM. Accepting `@Unsaid go` too is harmless.

Two guards that matter on stage:

- **Only the creator's `go` counts.** They are the one who knows the roster.
- **`go` arriving early** must be refused, not obeyed. If any participant's `missing` is non-empty, reply "still waiting on 2 people". Otherwise a premature `go` builds a plan on defaults, live.

## 6. Orchestrator state machine

It is **not** a library or a framework. It is one string on the plan document plus rules about what is allowed when — roughly twenty lines.

```
status: "collecting" | "negotiating" | "proposed" | "confirmed"

on inbound DM:
  plan = lookup(sender)
  switch (plan.status):
    collecting  -> slot-fill; if creator said "go" and everyone is ready -> negotiating
    negotiating -> if a question is pending for this sender: resumeNegotiation(...)
                   otherwise: "working on it", do not re-run
    proposed    -> tapback counts as confirm; text gets "the plan is X, tap to confirm"
    confirmed   -> "you are all set"
```

**Do not blanket-ignore input while `negotiating`.** Once an agent can ask its human a question, the reply arrives as an ordinary inbound DM — and swallowing it deadlocks the plan forever with no error. This is a silent hang, not a crash, so it will not show up in testing until someone actually gets asked something. See `negotiation-protocol.md`.

**Why bother instead of doing the steps in order?** Because messages arrive whenever humans feel like it, and without the status each of these is a live bug:

- someone answers a question *after* the card was posted → negotiation re-runs, a second card goes out
- `go` pressed twice → two negotiations, two cards
- a tapback lands while still collecting → nonsense or a crash

The status field is a guard that makes those boring. That is the whole value.

### The negotiating step

```ts
const people   = participants.map(p => ({ userId: p.userId, slots: p.slots }));  // Participant[]
const merged   = mergeConstraints(people);                   // three keys only
const filtered = filterVenues(VENUES, merged, travelProfiles(people));

// One call per person, over the survivors. Scoring does not need the time.
const evals    = await Promise.all(people.map(p => scoreCandidates(filtered.survivors, {
                   slots: p.slots, tastes: tastesOf(p), preferredSpots: spotsOf(p) })));

await store.appendRound({ planId, round, at: new Date().toISOString(),
                          candidates: /* survivors + scores, rejected + failedOn */ });

const chosen   = select(filtered.survivors, evals);          // A's rule, below
const card     = { venueId: chosen.venueId, time: pickTime(merged.window),
                   estCostUSD: venueById(chosen.venueId)!.estCostUSD };
```

Put this whole block behind **one local function** — `runNegotiation(planId, people)` — rather than inlining it in the switch. When B ships `negotiate()` (contract 12, `negotiation-protocol.md`), swapping it in is a one-line change, and A never writes a round loop: B owns the rounds because the pause state is B's.

**`merged.window` is not a venue filter.** B's venue records dropped `hours` because the demo is one evening, so every venue is open. `filterVenues` applies budget, dietary and travel; A reads `merged.window` only to assign the card's time. `hasOverlap(merged.window)` returning false means the group has no shared time at all.

Empty `survivors`, or every candidate failing, is the flex-whisper branch (stretch) — otherwise send "nothing fits" and drop back to `collecting`.

## 7. Selection rule

Best worst-case score, so the least-happy person is as happy as possible; ties broken by the shorter longest commute:

```ts
const travel = new Map(survivors.map(s => [s.venueId, s.longestTravelMin]));
const best = candidates
  .map(c => ({ c, worst: Math.min(...evalsFor(c.venueId).map(e => e.score)) }))
  .filter(x => evalsFor(x.c.venueId).every(e => e.pass))
  .sort((a, b) => b.worst - a.worst
                || travel.get(a.c.venueId)! - travel.get(b.c.venueId)!)[0];
```

`longestTravelMin` is an aggregate whose person is unlabeled, which is how "minimize the longest commute" works without A ever seeing anyone's home or travel cap.

## 8. Fan-out delivery

One message **per participant, on that participant's own line**. The app sends three separate DMs, each from that person's Unsaid to that person. Nobody's number sends to anybody else.

The non-obvious dependency: to message someone you need their `space`, and A only holds one for whoever just texted. Fanning out to people who are not currently texting needs either a space id stored at join time or `space.create` with their handle — and on Pro, `space.create` only reaches **registered project users**, so every demo phone must be registered before the run.

**This was not in the original plan at all**, because a group post needed exactly one space. It is the kind of thing that fails at 10:40pm, so test it in the first hour.

## 9. Confirmations

A sent card **cannot be edited**, so there is no live tracker inside the message. Confirmations go two places:

- **The backroom screen** — the natural home for a live tracker, and it already polls. `dev ✓ · priya ✓ · maya …` updating on the projector is a better beat than a self-editing text would have been.
- **One follow-up message at quorum** — a single "everyone is in" once the last tapback lands. Do not message on every confirm: three people × three threads is nine notifications.

Decide quorum explicitly: all participants, or first tapback wins. The shared doc says "people confirm with a tapback" without specifying, so pick one and say it in the demo.

## Calling into B's code

**A adds no type definitions.** All nine contract shapes are exported from `src/contracts.ts` on `main`. Import them; never redeclare them.

This repo has `verbatimModuleSyntax` and `allowImportingTsExtensions` on, so types need `import type` and every path needs its `.ts` extension. Omitting either fails the typecheck with an error that does not say why:

```ts
import type { Evaluation, MergedConstraints, RoundLog } from "./contracts.ts";
import { VENUES, filterVenues, venueById } from "./venues.ts";
```

### Functions that exist and pass their tests

| Import from | Signature |
|---|---|
| `./db.ts` | `openStore(opts?): Promise<Store>` — Mongo when `MONGODB_URI` is set, else in memory. Call **once at startup** |
| `./db.ts` | `store.createPlan(plan: PlanDoc): Promise<boolean>` — **false** if the code is taken or the planId exists |
| `./db.ts` | `store.getPlanByJoinCode(code): Promise<PlanDoc \| null>` — only matches a plan that is still live |
| `./db.ts` | `store.getPlan(planId)`, `store.addParticipant(planId, userId)` (idempotent), `store.setStatus(planId, status)` |
| `./db.ts` | `store.appendRound(round)`, `store.listRounds(planId)` — contract 7 |
| `./db.ts` | `store.setActivePlan(userId, planId)` — **use this on join. Never `upsertUser`** |
| `./db.ts` | `store.appendMessage(...)`, `store.listMessages(...)` — B writes these inside `handleDM`; A does not call them |
| `./slots.ts` | `missingSlots(slots)`, `nextQuestion(missing)` — exported if A wants to inspect readiness herself |
| `./slots.ts` | `handleDM(input: HandleDMInput, store: Store): Promise<HandleDMResult>` |
| `./aggregator.ts` | `mergeConstraints(people: Participant[], day?: Date): MergedConstraints` |
| `./aggregator.ts` | `travelProfiles(people: Participant[]): TravelProfile[]` |
| `./aggregator.ts` | `hasOverlap(window: TimeWindow): boolean` — false means no shared time |
| `./venues.ts` | `filterVenues(venues: Venue[], merged: MergedConstraints, people: TravelProfile[]): FilterResult` |
| `./venues.ts` | `VENUES: Venue[]` (50 of them), `venueById(id): Venue \| undefined` |
| `./agent/score.ts` | `scoreCandidates(survivors: Survivor[], ctx: ScoreContext): Promise<Evaluation[]>` |

`Participant` is `{ userId: string; slots: Slots }`; `ScoreContext` is `{ slots: Slots; tastes: string[]; preferredSpots: string[] }`.

Two that are easy to call wrongly:

- **`handleDM` takes the store as a second argument**, and a third optional `day: Date` that A can ignore. It loads slots, seeds from the standing profile, persists, and stores the message — so A never reads or writes slots directly.
- **`handleDM` also runs onboarding**, invisibly to A. A first-time user is asked four profile questions (where they head out from, dietary needs, times that never work, favourite places) before any plan questions. A's code is identical either way; the only observable difference is that a first-ever plan takes about eight messages to fill rather than four, so `missing` stays non-empty longer. **Pre-seed the demo users' profiles** and the demo shows the fast path: a returning user finishes in three answers, and the reply says what it reused.
- **`filterVenues` takes `TravelProfile[]`, not participants.** Build it with `travelProfiles(people)`. Homes and travel caps live inside that array and never reach A's own logic — that is the mechanism behind the privacy claim, not a convention.

### What changed on B's side — read this if the doc looks out of date

Everything below is built, exported and covered by `npm run harness` (51 assertions, green against real Atlas and green with no API keys).

**Types that changed in `contracts.ts`:**

| Change | Why it matters to A |
|---|---|
| `UserDoc.profile.defaultBudgetUSD` **removed** | Cost depends on the occasion — brunch vs a fancy dinner — so budget is asked every plan and never persisted. If A referenced it, the compiler will say so |
| `UserDoc.profile.blackouts?: Blackout[]` **added** | Standing times that never work (`{ days: [2], start: "18:00", end: "23:59" }`). Availability varies per plan; impossibility does not. B clips the per-plan window against these automatically |
| `StoredMessage` **added** | Every DM is now stored both directions per (planId, userId) |
| `UserDoc.askedProfile` / `onboardedAt` **added** | Onboarding state. B's, not A's |

**Who owns what inside `users`** — this is the one place a careless write does real damage:

| Field | Owner |
|---|---|
| `profile`, `askedProfile`, `onboardedAt` | **B** — written by onboarding and write-back |
| `activePlanId` | **A**, but only through `store.setActivePlan(userId, planId)` |

`upsertUser` replaces the whole document. Calling it to set `activePlanId` would wipe the profile and onboarding state that `handleDM` just built, and the person would be re-onboarded from scratch mid-demo. `setActivePlan` touches one field and creates the user if absent, so A never needs `upsertUser`.

**Behaviour changes worth knowing:**

- **Money is asked last.** `missingSlots` now returns location, time, travel, dietary, budget in that order, because the product exists precisely because budget is the thing nobody wants to say out loud. `REQUIRED_SLOTS` in `contracts.ts` is still the canonical *set* — ordering is presentation only.
- **`openStore({ memory: true })`** forces the in-memory store even when `MONGODB_URI` is set. Useful if A wants deterministic tests of her own router without writing to Atlas.
- **`npm run harness`** runs the whole of B's lane plus a live MongoDB probe; **`npm run backroom`** serves the projector view on port 4321.

### What A needs from B

**Nothing is outstanding.** `getPlanByJoinCode` and the rest of the plan CRUD are built and covered by assertions, so nothing needs stubbing.

Two behaviours to rely on rather than reimplement:

- **A join code only resolves while the plan is live** (`collecting` / `negotiating` / `proposed`). A confirmed plan stops answering to its code, so codes are reusable across demo re-runs and a stale code cannot pull someone into a finished plan.
- **`createPlan` returns `false`** if the code is already held by a live plan or the planId exists — so A cannot mint a duplicate by accident. No uniqueness check needed on A's side.

### What has no running code yet

Contracts 1, 2, 3, 4, 6 and 8 are implemented and covered by `npm run harness` — **51 assertions**, green against real Atlas and green with no API keys at all. Contracts 5, 7 and 12 are types with nothing behind them on either side; contract 9 (Nessie) is A's.

**One caveat that matters at 9pm:** the Grok branch of `extract()` has still never executed, because no `XAI_API_KEY` has been set. Everything that passes today runs the offline extractor. Both paths fail *silently* to the fallback, so a wrong model name or a broken prompt looks exactly like success — extraction just gets quietly worse. Set the key and re-run the harness before the end-to-end run.

## Contracts, from A's side

| # | Contract | A's side | Settle by |
|---|---|---|---|
| 1 | Slot schema + resolvers | Consume only — A never parses text | 4pm |
| 2 | Inbound DM handoff | A calls `handleDM`, sends B's `reply` verbatim | 4pm |
| 3 | Venue JSON + filter | A calls `filterVenues`; B implements | 4pm |
| 4 | Merged constraints | A receives exactly `budgetCapUSD`, `requiredDietary`, `window` | 5pm |
| 5 | Candidate plan | **A produces** — assigns the time from `merged.window` | 5pm |
| 6 | Evaluation | A receives pass/fail + score + `needsMyHuman`. No reason, no travel | 5pm |
| 7 | `rounds` shape | **A writes it**, B's screen reads it — agree early, it is B's unblock | 5pm |
| 8 | `users` / `plans` | A creates the plan, owns `joinCode`, `participants`, `status` | 5pm |
| 9 | Nessie anchor | A writes `budgetCapUSD`, the same field the slot schema defines | 9pm |
| 12 | `negotiate` / `resumeNegotiation` | **Proposed.** A calls, handles `settled` / `waiting` / `failed`. See `negotiation-protocol.md` | only if built |

**Contract 8 is the one with a silent failure mode:** `users.profile` is now built by B's onboarding and write-back, not seeded by hand. A's join flow must never write `users` wholesale — use `store.setActivePlan(userId, planId)`, which touches one field. `upsertUser` would wipe the profile and re-onboard the person mid-demo. With no group chat, `joinCode` is now the *only* participant source, so it is load-bearing rather than a convenience.

**Contract 7 is B's critical path.** Agree the `rounds` shape before dinner even if the orchestrator does not exist yet; B builds the entire backroom screen against hand-written fake rounds.

**Contracts 5, 6 and 7 have a proposed change pending.** Read the next section before writing the state machine — one small decision now avoids a rewrite later.

## Proposed: agent-to-agent negotiation — NOT BUILT

**Status: proposed, no code exists.** `src/contracts.ts` on `main` is unchanged and every signature above is still accurate. Do not build against this section. **The full spec is `docs/negotiation-protocol.md`** — move types, termination, contract 12 and the pause/resume semantics live there; this section is the summary. It is here because one decision in A's state machine is much cheaper to make now than later — the `maxRounds = 1` loop in step 6.

### What it is

Personal agents emit **typed, unattributed objections** (`{ kind: "budget", cap: 25 }`) instead of only a score. An orchestrator agent reasons over the objection multiset — it learns *that* a $25 cap exists, never *whose* — proposes the next candidate, and narrates for the backroom screen. Capped rounds, with today's `select()` as the guaranteed terminator.

The privacy claim gets weaker and the wording matters: **categories are disclosed, people are not, and the pairing between them never is.** With three people an anonymous objection is often re-identifiable by inference, so nobody should claim it is airtight.

### Blast radius on A

| # | Contract | Change | Breaks A's code? | A's action |
|---|---|---|---|---|
| 5 | `CandidatePlan` | one proposal per round rather than one card | No — type barely moves | Shape `negotiating` as a loop |
| 6 | `Evaluation` | gains `objection?: Objection` | **No — optional field** | Forward it into the round log; never interpret it |
| 7 | `RoundLog` | gains `moves: Move[]` and `narration: string` | No to the compiler, **yes to the demo** | Populate them once they exist, or B's screen shows no transcript |
| 10 | `NegotiationTurn` *(new)* | orchestrator agent input/output | n/a | A calls, B implements |
| 11 | `FlexRequest` *(new)* | anonymous objection → a specific person | n/a | A sends the DM, B resolves whose objection it is |
| 1, 2, 3, 4, 8, 9 | — | unchanged | No | Nothing |

The **types are additive and non-breaking; the control flow is not.** That asymmetry is the whole reason this section exists.

### Who owns the orchestrator agent

It lands on the lane seam: "orchestrator" is A's, "agents" is B's. **Recommendation: B implements `negotiateRound(turn): Promise<NegotiationTurn>`, A calls it from the state machine** — the same shape as `filterVenues`. Every Grok call already lives in B's lane, A's lane is flow control, and A is carrying the messaging risk. Settle this out loud rather than assuming; it is the one genuinely ambiguous ownership call in the project.

## Insulating A from future framework changes

If B later adopts an agent framework, whether A is affected depends on one rule:

> **Every B → A interface stays a plain in-process TypeScript async function. Any framework lives *inside* one of those functions, never across the boundary.**

Hold that and a framework swap is invisible to A. Break it and here is what lands on A's desk:

| Framework behaviour | What it does to A |
|---|---|
| **Owns the control loop** (LangGraph's whole model) | Collides head-on with A's state machine — both want to drive. A lane renegotiation, not a refactor |
| **Shared blackboard between agents** | Breaks contract 4's three-key guarantee and the harness assertion enforcing it. Also kills the reveal |
| **Persists its own agent state** | Collides with contract 8, where plan state lives in Mongo under A's ownership |
| **Python-only** (AutoGen, CrewAI, NeMo all are) | The worst for A: `handleDM` stops being an import and becomes an RPC call. Contract 2 turns from a function call into a network call, with new latency and failure modes in A's router |

That last row is the one to veto: a TypeScript-to-Python boundary sitting in the DM path costs more than any framework returns.

### If LangGraph is adopted anyway

`@langchain/langgraph` is the only TS-native option worth considering, and it is containable. Graph state carries **only unattributed data** —

```ts
type NegotiationState = {
  round: number;
  proposal: string | null;
  objections: Objection[];   // no agent, no userId
  history: Move[];
};
```

— with each agent node closing over its own person's slots rather than reading them from state. Private data lives in closures; the graph sees only the anonymised layer. B then exposes `negotiateRound(turn)` and the framework never crosses the lane boundary, so **A imports nothing from LangChain.**

Adopt only if all three hold after the 9pm checkpoint: the full flow works across three phones; the plain-code negotiation loop already runs; and there are ≥45 minutes spare that are not needed for rehearsal. Porting a working loop is mechanical; debugging a graph written before the loop worked is unbounded.

## Nessie

Seed a mock customer plus a plausible dinner purchase history per demo phone, then the anchor line in the DM: *"You usually spend about $X on dinner. Still good?"* The reply resolves into `budgetCapUSD` through B's money resolver — the same field, never a second budget field. Sponsor requirement is that it is visible in the demo, so the line has to appear on screen during the run.

## Order of work

1. **4–5pm** — Spectrum Cloud project; confirm each demo phone can DM its own line and the app receives all of them; repo open in Cursor (SpaceXAI requires it); Atlas cluster. Agree contracts with B in the first 20 minutes.
2. **5–7pm** — Message loop, router's four branches, join code create + resolve, slot-filling wired to `handleDM`.
3. **7:30–9pm** — State machine, `go` trigger, fan-out delivery, tapback confirm.
4. **9–10:30pm** — End-to-end across three phones, bug fixes, Nessie seed + anchor line.
5. **10:30pm–12am** — Freeze, rehearse, record the backup video.

If a checkpoint slips more than 30 minutes, cut the next stretch item rather than pushing the schedule.

## Verification

Do the first five in the first hour. Items 3 and 5 are the two that can quietly sink the demo.

1. **Three distinct senders.** Each demo phone DMs its assigned line and the app receives all three with **different `message.sender.id`** values.
2. **All lines heard.** Bare `imessage.config()` really does receive across every project line — no `clients` pinning.
3. **Blue, not green.** Messages arrive as iMessage. Tapbacks and message effects are iMessage-only; if it falls back to SMS, the confirm step has no mechanism and the fallback is a text reply ("reply YES").
4. **Tapback shape.** A tapback arrives as `message.content.type === "reaction"`.
5. **Proactive outbound.** The app can initiate a DM to a phone that has not messaged it yet — required for fan-out.
6. **Router truth table.** No plan + `JOIN <code>` joins; no plan + anything else creates; has plan + `go` from the creator transitions; has plan + `go` from a non-creator does not; has plan + anything else slot-fills.
7. **Join correctness.** Two phones DM the same code and land on the same `planId`; a third with a different code does not.
8. **Premature `go`.** With one participant's slots unfilled, `go` is refused with a "still waiting" reply and the status does not change.
9. **Contract 4 guard.** Assert the object B hands over has exactly three keys, so a later edit cannot leak a per-person field into A's side.
10. **Terminal provider.** Add it alongside iMessage so the flow is drivable without phones; it is also the fallback if venue Wi-Fi dies.
11. **End-to-end (9pm checkpoint).** Three phones, each with a secret constraint, producing one plan card per person that everyone tapbacks.
12. **Backup video recorded before midnight** — the shared doc treats this as a checkpoint, not a nice-to-have.

## Open questions for A

- **Quorum:** all participants must tapback, or first tapback wins? Pick one and say it in the demo.
- **Join code collisions** across demo re-runs — enforce uniqueness at creation, or scope lookup to active plans?
- **Space reuse for fan-out:** store each participant's space id at join time, or call `space.create` at send time? Whichever, prove it in the first hour.
- **Setup, not code:** each demo phone needs its own Unsaid number saved in contacts before the demo, since the invite is a code rather than a link. Who does that, and when?
