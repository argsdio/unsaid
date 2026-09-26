# Unsaid — teammate A lane: messaging and flow

## Context

DivHacks build night, 4pm–12am. **A owns messaging and flow** (Spectrum, router, join codes, orchestrator state machine, Nessie); **B owns agents, data and screen** (Grok extraction and scoring, aggregator, venues, backroom screen). B's lane is in `plan-teammate-b.md` in this folder.

**Photon constraint (settled):** hackathon credits are **Spectrum Cloud Pro**, not Business. Pro is a **shared-pool 1:1 iMessage line**. Group create and a dedicated bot-in-the-group number are Business-only. We do **not** pivot the product. We drop Unsaid as a group member.

The product read for judges: the human group chat is where social pressure lives, so Unsaid **refuses to speak there**. Constraints stay in DMs. Photon is only the pipe; attaching people to a plan is **our backend** (contract 8).

One shared repo: A imports `src/contracts.ts` from B; the compiler catches contract drift. A never edits B's modules (`contracts.ts`, `venues.ts`, `aggregator.ts`, `agent/`, `db.ts`, `backroom/`, `slots.ts`).

## Product surface on Pro

| Old (needs Business group line) | What we ship on Pro |
|---|---|
| `@Unsaid dinner Friday?` in the group | Anyone DMs Unsaid: `dinner Friday?` (or similar) |
| Bot posts an `sms:` join link in the group | Bot replies in the DM with a 4-char code + “paste this in the group” |
| Bot posts the plan card in the group | Bot sends the card to **each participant DM**; optional paste blurb for the creator |
| Tapbacks on the group card | Tapbacks (or “yes”) on the DM card |

Human iMessage group stays in the **demo** as a bulletin board. Unsaid is not a member. If someone only sees the code in the group and never DMs Unsaid, they are not in the plan.

Shared-pool numbers may **differ per person**. Do not depend on one global bot phone in an `sms:` URL. Source of truth: `JOIN K7M2` typed into the 1:1 they already have.

## Spectrum API — still true, used differently

Read out of `node_modules/@spectrum-ts/core` and `node_modules/@spectrum-ts/imessage`.

| Need | How | Note |
|---|---|---|
| Group or DM? | `space.type` is `"dm" \| "group"` | On Pro we **skip groups**. No mention-gating to build |
| Who sent it? | `message.sender.id` | Canonical platform handle (the phone). This *is* the user id |
| Tapback in | `message.content.type === "reaction"` | Confirm on the **DM** plan card |
| Tapback out | `message.react(emoji)` | |
| Plan card effect | `effect(content, …)` from `@spectrum-ts/imessage` | Works in a DM |
| Participants | **Not** `space.getMembers()` | Throws on a DM; Pro has no group space anyway. Join codes only |
| Outreach | `space.create(user)` / existing DM | Pro allowlist: demo phones must be registered project users |

Photon does **not** have plans, join codes, or “a group of agents.” Spectrum yields `[space, message]`. We map sender → `userId` → `activePlanId` → `handleDM`.

## The venue schema change (unchanged)

B dropped `hours` (one evening). **`merged.window` is not a venue filter — it is how A picks the time.** B's `filterVenues` applies budget, dietary and travel. A assigns a time from `merged.window` when building the card sent to each DM.

## Files

```
src/
  index.ts              entry: openStore, Spectrum iMessage, dispatch
  router.ts             skip groups; DMs always on; JOIN/start vs handleDM
  join.ts               createPlan, join code, attach participant, activePlanId
  orchestrator/
    machine.ts          Collecting -> Negotiating -> Proposed -> Confirmed
    select.ts           best worst-case score, tiebreak on longest commute
    messages.ts         DM copy: plan card, confirm, "nothing fits", paste blurb
  nessie.ts             seed customers + purchases, budget anchor line
```

## Router

```ts
for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  if (message.content.type === "reaction") { await onTapback(space, message); continue; }
  if (message.content.type !== "text") continue;
  if (space.type === "group") continue;            // Pro: never a group bot
  await onDirectText(space, message);              // DMs always on
}
```

`onDirectText` is the only inbound path. **A owns join/start parsing** (not slot text). Then A calls B:

```ts
const store = await openStore();                     // once at startup
const { slots, missing, reply } = await handleDM({ planId, userId, text }, store);
await space.send(reply);                            // B writes slot-filling copy
```

Suggested DM commands (A, before `handleDM`):

- Start (`dinner Friday?` / `plan …` with no active plan) → create `PlanDoc`, 4-char `joinCode`, creator already in `participants`, set `activePlanId`. Reply with the code and “forward this to the group.” Then `handleDM` for slot-fill.
- `JOIN xxxx` (or a lone 4-char code) → look up plan, append `userId` if new, set `activePlanId`. Short “you’re in,” then `handleDM` or next missing question.
- Else → `handleDM` on `activePlanId`. If none, ask them to start a plan or paste a join code.

MVP: one active plan per user; a new join code switches `activePlanId`. **Do not** `upsertUser` wholesale — B seeds `profile.preferredSpots`. Touch only `activePlanId`.

When every participant on that plan has `missing.length === 0`, A advances `status` to `negotiating`. Collecting “everyone’s data” is `store.getAllSlots(planId)`, not a Photon API.

## Join flow (hub and spoke)

1. Creator DMs Unsaid → A creates the plan + code (creator is joined).
2. Creator pastes the code into the **human** group chat.
3. Each friend DMs **their** Unsaid `JOIN <code>`. Same `planId` in our store. Agents never text each other.
4. Slot-filling stays 1:1 via `handleDM`.
5. After negotiate, A fans the plan card out to each known participant DM (the space that last messaged, or `space.create` if needed and allowlisted).

## Orchestrator state machine

| State | A does | Calls into B |
|---|---|---|
| `collecting` | Per DM, join/start then `handleDM`; when every participant's `missing` is empty, advance | `handleDM` |
| `negotiating` | Merge, filter, assign times, request scores, log the round, pick | `mergeConstraints`, `travelProfiles`, `filterVenues`, `scoreCandidates` |
| `proposed` | Send the plan card **to each participant DM** with a message effect; wait for tapbacks | — |
| `confirmed` | DM confirmation to each participant; optional paste line for the creator | — |

Negotiating step in order:

```ts
const people   = participants.map(p => ({ userId: p.userId, slots: p.slots }));
const merged   = mergeConstraints(people);
const filtered = filterVenues(VENUES, merged, travelProfiles(people));

const evals    = await Promise.all(people.map(p => scoreCandidates(filtered.survivors, {
                   slots: p.slots, tastes: tastesOf(p), preferredSpots: spotsOf(p) })));

await store.appendRound({ planId, round, at: new Date().toISOString(),
                          candidates: /* survivors + scores, rejected + failedOn */ });

const chosen   = select(filtered.survivors, evals);
const card     = { venueId: chosen.venueId, time: pickTime(merged.window),
                   estCostUSD: venueById(chosen.venueId)!.estCostUSD };
// send card into each participant DM — not a group space
```

Empty `survivors`, or every candidate failing, is flex-whisper (stretch) — otherwise DM “nothing fits” and go back to `collecting`.

## Selection rule

Best worst-case score; ties broken by the shorter longest commute:

```ts
const travel = new Map(survivors.map(s => [s.venueId, s.longestTravelMin]));
const best = candidates
  .map(c => ({ c, worst: Math.min(...evalsFor(c.venueId).map(e => e.score)) }))
  .filter(x => evalsFor(x.c.venueId).every(e => e.pass))
  .sort((a, b) => b.worst - a.worst
                || travel.get(a.c.venueId)! - travel.get(b.c.venueId)!)[0];
```

`longestTravelMin` is unlabeled. A never sees anyone’s home or travel cap.

## Calling into B's code

**A adds no type definitions.** Import from `src/contracts.ts`. `verbatimModuleSyntax` + `allowImportingTsExtensions`: use `import type` and `.ts` extensions.

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
| `./aggregator.ts` | `hasOverlap(window: TimeWindow): boolean` |
| `./venues.ts` | `filterVenues(venues: Venue[], merged: MergedConstraints, people: TravelProfile[]): FilterResult` |
| `./venues.ts` | `VENUES: Venue[]`, `venueById(id): Venue \| undefined` |
| `./agent/score.ts` | `scoreCandidates(survivors: Survivor[], ctx: ScoreContext): Promise<Evaluation[]>` |

`Participant` is `{ userId: string; slots: Slots }`; `ScoreContext` is `{ slots: Slots; tastes: string[]; preferredSpots: string[] }`.

Easy to call wrongly:

- **`handleDM` takes the store as a second argument.** A never reads or writes slots directly.
- **`filterVenues` takes `TravelProfile[]`**, from `travelProfiles(people)`, not raw participants.

### The four things A writes

1. **The router** (contract 2) — skip groups; resolve sender, JOIN/start, `handleDM`, send `reply` verbatim.
2. **The candidate builder** (contract 5) — venue + time from `merged.window`; **deliver in DMs**.
3. **The round append** (contract 7) — `store.appendRound(round)` every round. Until this lands, B’s screen uses `DEMO_ROUNDS`.
4. **Join + Nessie** (contracts 8, 9) — our store, not Photon.

### Where the code and the contract table disagree

`scoreCandidates` takes `Survivor[]`, not `CandidatePlan`. Time is not needed to score, only to put on the DM card. **Settle:** A passes survivors through and treats `CandidatePlan` as A-internal (A → each DM), or B widens the scorer.

### What has no running code yet

Contracts 1, 3, 4 and 6: `npm run harness`. Contract 2: `handleDM` exists; A’s router now calls it per DM but **join codes / shared `planId` are not done** (today each sender is `solo:<userId>`). Contracts 5, 7, 9 still need A.

## Contracts, from A's side

| # | Contract | A's side |
|---|---|---|
| 1 | Slot schema + resolvers | Consume only — A never parses slot text |
| 2 | Inbound DM handoff | A calls `handleDM`, sends B's `reply` verbatim |
| 3 | Venue JSON + filter | A calls `filterVenues`; B implements |
| 4 | Merged constraints | A receives exactly `budgetCapUSD`, `requiredDietary`, `window` |
| 5 | Candidate plan | **A produces** and **DMs** it; not a group post |
| 6 | Evaluation | pass/fail + score + `needsMyHuman`. No reason, no travel |
| 7 | `rounds` shape | **A writes it**, B's screen reads it |
| 8 | `users` / `plans` | A creates the plan, owns `joinCode`, `participants`, `status` |
| 9 | Nessie anchor | A writes `budgetCapUSD`, the same field the slot schema defines |

**Contract 8 silent failure:** do not clobber `users.profile`. **Contract 7** is still B’s backroom unblock — agree the shape even before the orchestrator exists.

## Nessie

Seed a mock customer plus dinner history per demo phone. Anchor line in the **DM**: *"You usually spend about $X on dinner. Still good?"* Reply resolves into `budgetCapUSD` through B’s money resolver. Must be visible on a phone during the demo.

## Order of work

1. Spectrum Cloud Pro: DMs working (done). Skip group-bot verification.
2. Replace `solo:<userId>` with create-plan + `JOIN` so two phones share one `planId`.
3. State machine; plan card + effect + tapback **in DMs**; wire negotiate to B.
4. End-to-end: three phones, human group without Unsaid, three Unsaid DMs, one card each.
5. Nessie line; freeze; backup video.

If a checkpoint slips more than 30 minutes, cut stretch (flex whisper, conversational debate overlay) rather than the DM join.

## Verification

- **Terminal provider** alongside iMessage so join codes work without phones; Wi-Fi fallback.
- **Router:** group inbound ignored; DM always handled; reaction → `onTapback`, never slot text.
- **Join:** two phones `JOIN` the same code → same `planId`; a third phone with a different code does not; Photon APIs never used to list members.
- **`getMembers()` never called.**
- **Contract 4:** merged object has exactly three keys.
- **9pm:** three DMs, secret constraints, one plan card in each DM, tapbacks there. Human group only ever contains the join code (and optionally a pasted card).
- Backup video before midnight.

## Open questions for A

- Tapback confirm: all participants, or first tapback wins? Pick one and say it in the demo.
- Fan-out: reply only in sessions that already inbound vs `space.create` for quiet participants (Pro allowlist).
- Conversational “agents advocate” overlay: stretch on the backroom **after** a working DM card; do not replace merge/filter/maximin.
