# Unsaid — teammate A lane: messaging and flow

## Context

DivHacks build night, 4pm–12am. The shared build plan doc splits the work two ways: **A owns messaging and flow** (Spectrum, router, join link, orchestrator state machine, Nessie); **B owns agents, data and screen** (Grok extraction and scoring, aggregator, venues, backroom screen). B's lane is in `plan-teammate-b.md` in this folder.

A's lane carries the project's biggest risk, which is why the doc says to verify the iMessage group + DM flow before building anything on top of it. Good news below: most of that verification is already done from the installed types, and the one risk the doc worried about most turns out not to exist.

**Assumption to confirm at 4pm:** one shared repo, so A imports `src/contracts.ts` from B directly and the compiler catches contract drift. If A works in a separate repo, that file gets hand-copied and nothing enforces it.

## Spectrum API — verified against the installed package

Read out of `node_modules/@spectrum-ts/core` and `node_modules/@spectrum-ts/imessage`, so these are facts, not guesses. This is most of the doc's "verify in the first hour" list, already done.

| Need | How | Note |
|---|---|---|
| Group or DM? | `space.type` is `"dm" \| "group"` | iMessage space schema is `{ id, type, phone }` — typed, no sniffing needed |
| Who sent it? | `message.sender.id` | Canonical platform handle (the phone). **The doc's "group sender IDs unavailable" risk does not apply** |
| Mention-gating | `message.mentions` → `{ address, length, start }[]` | Gate group replies on our own phone appearing in `mentions` |
| Tapback in | `message.content.type === "reaction"` | This is how confirm is detected |
| Tapback out | `message.react(emoji)` or `space.send(reaction(emoji, msg))` | |
| Plan card effect | `effect(content, messageEffects.confetti)` from `@spectrum-ts/imessage` | Also `fireworks`, `sparkles`, `lasers`, `balloons`, `celebration`, `echo`, `heart`, `spotlight` |
| Participants | `space.getMembers()` | **iMessage: group only and remote only — throws on a DM.** Do not build the join flow on this |

The `getMembers()` restriction is the one real gotcha: it cannot enumerate a DM, so participants must come from join codes, not from asking the platform. That is what the join code is for, and the doc's fallback row already assumes it.

## The one thing the venue schema change pushed onto A

B's venue records dropped `hours` (demo scope is a single evening, so every venue is open). Consequence: **`merged.window` is not a venue filter — it is how A picks the time.** B's `filterVenues` applies budget, dietary and travel; A reads `merged.window` and assigns a time to each candidate before sending the candidate plan back to B for scoring.

## Files

```
src/
  index.ts              entry: gate on space.type + mentions, dispatch
  router.ts             group vs DM, sender -> user, user -> active plan
  join.ts               createPlan, join code, sms: deep link
  orchestrator/
    machine.ts          Collecting -> Negotiating -> Proposed -> Confirmed
    select.ts           best worst-case score, tiebreak on longest commute
    messages.ts         group copy: plan card, confirm, "nothing fits"
  nessie.ts             seed customers + purchases, budget anchor line
```

B owns `contracts.ts`, `venues.ts`, `aggregator.ts`, `agent/`, `db.ts`, `backroom/`. A imports from them and never edits them.

## Router

```ts
for await (const [space, message] of app.messages) {
  if (message.content.type === "reaction") { await onTapback(space, message); continue; }
  if (message.content.type !== "text") continue;

  if (space.type === "group") {
    if (!mentionsUs(message)) continue;            // mention-gated
    await onGroupText(space, message);
  } else {
    await onDirectText(space, message);            // DMs always on
  }
}
```

`onDirectText` resolves the sender's active plan and hands the raw text straight to B — A never parses message text:

```ts
const store = await openStore();                     // once at startup, not per message
const { slots, missing, reply } = await handleDM({ planId, userId, text }, store);
await space.send(reply);                            // B writes the DM copy
```

## Join flow

1. `@Unsaid dinner Friday?` in the group → create a plan, status `collecting`, generate a 4-character join code, post the code plus the `sms:` deep link.
2. The link pre-fills the join code in a DM so each person's first message ties them to the plan: `sms:<bot-phone>&body=JOIN%20<code>`. iOS is inconsistent about `&body=` vs `?body=` — test both on the actual demo phones in the first hour, it is a one-character fix either way.
3. The creator is joined implicitly and skips the link.
4. MVP rule from the doc: one active plan per user; a new join code switches the user's active plan.

## Orchestrator state machine

| State | A does | Calls into B |
|---|---|---|
| `collecting` | Per DM, ask B to fill slots; when every participant's `missing` is empty, advance | `handleDM` |
| `negotiating` | Merge, filter, assign times, request scores, log the round, pick | `mergeConstraints`, `travelProfiles`, `filterVenues`, `scoreCandidates` |
| `proposed` | Post the plan card with a message effect; wait for tapbacks | — |
| `confirmed` | Post confirmation | — |

The negotiating step in order:

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

Empty `survivors`, or every candidate failing, is the flex-whisper branch (stretch) — otherwise post the "nothing fits" message and go back to `collecting`.

## Selection rule

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

## Calling into B's code

**A adds no type definitions.** All nine contract shapes are already exported from `src/contracts.ts` on `main`. Import them; never redeclare them.

This repo has `verbatimModuleSyntax` and `allowImportingTsExtensions` on, so types need `import type` and every path needs its `.ts` extension. Omitting either fails the typecheck with an error that does not say why:

```ts
import type { Evaluation, MergedConstraints, RoundLog } from "./contracts.ts";
import { VENUES, filterVenues, venueById } from "./venues.ts";
```

### Functions that already exist and pass their tests

| Import from | Signature |
|---|---|
| `./db.ts` | `openStore(): Promise<Store>` — Mongo when `MONGODB_URI` is set, else in memory |
| `./slots.ts` | `handleDM(input: HandleDMInput, store: Store): Promise<HandleDMResult>` |
| `./aggregator.ts` | `mergeConstraints(people: Participant[], day?: Date): MergedConstraints` |
| `./aggregator.ts` | `travelProfiles(people: Participant[]): TravelProfile[]` |
| `./aggregator.ts` | `hasOverlap(window: TimeWindow): boolean` — false means no shared time |
| `./venues.ts` | `filterVenues(venues: Venue[], merged: MergedConstraints, people: TravelProfile[]): FilterResult` |
| `./venues.ts` | `VENUES: Venue[]` (50 of them), `venueById(id): Venue \| undefined` |
| `./agent/score.ts` | `scoreCandidates(survivors: Survivor[], ctx: ScoreContext): Promise<Evaluation[]>` |

`Participant` is `{ userId: string; slots: Slots }`; `ScoreContext` is `{ slots: Slots; tastes: string[]; preferredSpots: string[] }`.

Two that are easy to call wrongly:

- **`handleDM` takes the store as a second argument.** It loads existing slots, seeds from the standing profile and persists, so A never reads or writes slots directly.
- **`filterVenues` takes `TravelProfile[]`, not participants.** Build it with `travelProfiles(people)`. Homes and travel caps live inside that array and never reach A's own logic — that is the mechanism behind the privacy claim, not a convention.

### The four things A writes

1. **The router** (contract 2) — resolve sender and active plan, call `handleDM`, send `reply` verbatim.
2. **The candidate builder** (contract 5) — pair the chosen venue with a time from `merged.window`.
3. **The round append** (contract 7) — `store.appendRound(round)` every round. Until this lands, B's screen renders `DEMO_ROUNDS` fixtures.
4. **The join flow and the Nessie write** (contracts 8, 9).

Plus the selection rule below. Everything else is a call into B's modules.

### Where the code and the contract table disagree

`scoreCandidates` takes `Survivor[]`, not the `CandidatePlan` that contract 5 describes — it looks venue details up itself via `venueById`. Because `hours` was dropped, the assigned time is not needed to score a venue, only to post the plan card. So contract 5 currently flows A → group message rather than A → B. **Settle this at 5pm:** either A passes survivors straight through and `CandidatePlan` becomes A-internal, or B widens the scorer to accept it.

### What has no running code yet

Contracts 1, 3, 4 and 6 are implemented and covered by `npm run harness` (19 assertions, green with no API keys and no Atlas). Contract 2 is implemented but **never exercised** — `handleDM` has no test. Contracts 5, 7 and 9 are types with nothing behind them on either side, which makes them the three to walk through first.

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
| 8 | `users` / `plans` | A creates the plan, owns `participants` + `status` | 5pm |
| 9 | Nessie anchor | A writes `budgetCapUSD`, the same field the slot schema defines | 9pm |

**Contract 8 is the one with a silent failure mode:** B seeds ~15 preferred spots per demo user into `users`. A's join flow must not overwrite `users` wholesale — write `plans` and touch only `activePlanId` on the user.

**Contract 7 is B's critical path.** Agree the `rounds` shape before dinner even if the orchestrator does not exist yet; B builds the entire backroom screen against hand-written fake rounds.

## Nessie

Seed a mock customer plus a plausible dinner purchase history per demo phone, then the anchor line in the DM: *"You usually spend about $X on dinner. Still good?"* The reply resolves into `budgetCapUSD` through B's money resolver — the same field, never a second budget field. Sponsor requirement is that it is visible in the demo, so the line has to appear on screen during the run.

## Order of work

1. **4–5pm** — Spectrum Cloud project, echo bot answering in a real group chat *and* a DM, repo open in Cursor (SpaceXAI requires it), Atlas cluster. Agree contracts with B in the first 20 minutes.
2. **5–7pm** — Router (`space.type` gate, mention gate, sender → user → active plan), join code, `sms:` link tested on the real phones.
3. **7:30–9pm** — State machine, plan card with effect, tapback confirm, wire the router to B's agents.
4. **9–10:30pm** — End-to-end in iMessage, bug fixes, Nessie seed + anchor line.
5. **10:30pm–12am** — Freeze, rehearse, record the backup video.

If a checkpoint slips more than 30 minutes, cut the next stretch item rather than pushing the schedule.

## Verification

- **Terminal provider first.** Add the terminal provider alongside iMessage so the whole flow is drivable without phones; it is also the demo fallback if venue Wi-Fi dies.
- **Router truth table:** a group message without a mention is ignored; a group message with a mention is handled; a DM is always handled; a reaction routes to `onTapback` and never to the text path.
- **Join:** two phones DM the join code and both land on the same `planId`; a third phone with a different code does not.
- **`getMembers()` on a DM throws** — assert the code path never calls it outside a group.
- **Contract 4 guard:** assert the object B hands over has exactly three keys, so a later edit cannot leak a per-person field into A's side.
- **End-to-end (9pm checkpoint):** three phones in one group chat, each with a secret constraint, producing one plan card that everyone tapbacks.
- **Backup video recorded before midnight** — the doc treats this as a checkpoint, not a nice-to-have.

## Open questions for A

- `sms:` body pre-fill: `&body=` or `?body=` on the demo phones' iOS version?
- Does the Spectrum line's own phone number come from config (`imessage.config({ clients: [{ phone }] })`) or need a `photon spectrum lines list` lookup? Mention-gating needs our own address to compare against.
- Tapback confirm: all participants, or first tapback wins? The doc says "people confirm with a tapback" without a quorum — pick one and say it in the demo.
