# Unsaid — teammate B lane: contracts, resolvers, scaffold

## Context

DivHacks build night, 4pm–12am. **A owns messaging and flow** (Spectrum, router, join codes, orchestrator, Nessie); **B owns agents, data and screen** (Grok extraction and scoring, aggregator, venues, backroom screen). A's lane is in `plan-teammate-a.md` in this folder.

**Photon constraint (settled):** credits are **Pro**, not Business. Unsaid cannot sit in an iMessage group. The product is unchanged in thesis — private agents, merged limits in code, one fair plan — and only the **transport** changed: every Spectrum event is a **DM**. Join codes, `participants`, and `getAllSlots(planId)` live in **our store**. B does not talk to Photon groups and does not implement join.

B’s 7pm checkpoint is still a **terminal harness** with three fake users: no Spectrum, no A, no group chat.

One shared repo: A imports `src/contracts.ts`. If that ever splits, the file is hand-copied and nothing enforces drift.

## What this does *not* change for B

- Slot schema, resolvers, venues, aggregator, scorer, `handleDM`, `db.ts`, backroom.
- Privacy: orchestrator sees three merged keys; travel is an unlabeled `longestTravelMin` on survivors; evaluations have no reason and no per-person commute.
- A still **drives** filter/score timing; B still **implements** those functions.
- Contract 8: A creates plans and JOIN; B only fills `slots` via `handleDM` / `setSlots`. A must not clobber `users.profile` (seeded preferred spots).

## What this does change for B (demo and seams only)

- There is no “plan lands in the group.” A fans the same card to **each participant DM**. Contract 5 is A → DMs, not A → group space.
- The 9pm e2e is three Unsaid DMs plus a **human** group that only carries the join code. Backroom still reads `rounds` A appends (or `DEMO_ROUNDS` until then).
- Optional stretch (after a working card): backroom **advocacy overlay** on survivors. Do not replace `filterVenues` + graded `scoreCandidates` + A's maximin picker with a free-form debate that leaks constraints.

## Decisions settled (unchanged)

### Slot schema: free text in, resolved values out

```ts
type Slot<T> = {
  raw: string;
  value: T | null;
  confidence: "high" | "low";
};
```

Tri-state: slot absent = never asked; `value: []`/`0` = no restriction; `value: null` + `raw` = asked but not canonicalisable.

Neighborhoods → coordinates (gazetteer → Grok geocode → borough centroid). Dietary synonym map; `"I eat everything"` → `[]`. Unmatched phrases go to `unresolved[]` and **must not** hard-filter the survivor set. `tags` / `namedSpots` stay free text (soft score only).

### Venue filtering: B owns it, A calls it

Needed for the 7pm harness without A. A decides when to call, reads survivor count, branches to flex whisper. No `hours` on venues; `merged.window` is A's clock, not a filter key.

### Travel: enforced inside B, never reaches A

```ts
{ venueId: string, longestTravelMin: number }   // whose commute is unlabeled
```

`Evaluation` has no `travelMin`.

## Doc updates already applied (rev 11 → 17)

Venue count 50; hours dropped; nine contracts; merged constraints are three group fields; evaluation has `needsMyHuman`; ~15 seeded spots on `users.profile`. **Plus this Pro rewrite:** no group bot; join is A's store.

## Code scaffold

Dependencies: `mongodb`, `openai` (`https://api.x.ai/v1`), express for backroom.

```
src/
  contracts.ts        Slot<T>, the 9 wire types. A imports this.
  resolve/            gazetteer, location, dietary, money, time, duration
  venues.json         50 venues, 7-field schema
  venues.ts           filterVenues → survivors + rejected (failedOn category)
  travel.ts           haversine + NYC transit estimate
  aggregator.ts       mergeConstraints → MergedConstraints (exactly 3 keys)
  agent/
    extract.ts        DM text → raw slots
    score.ts          survivors → pass/fail + graded score + needsMyHuman
  slots.ts            handleDM(planId, userId, text, store)
  db.ts               users / plans / rounds (memory if no MONGODB_URI)
  backroom/           projector view of rounds
  harness.ts          3 fake users, no Spectrum, no A
```

`handleDM` is the only Spectrum-facing seam B owns. A’s router supplies `planId` after JOIN/start. B does not parse join codes.

Scoring is **graded**, not 1.0/0.0. `rejected[].failedOn` is `"budget" | "dietary" | "travel"` (and not a person or a reason).

## The nine contracts

| # | Contract | Direction |
|---|---|---|
| 1 | Slot schema + resolvers | shared |
| 2 | `handleDM({planId,userId,text}) → {slots,missing[],reply}` | A→B→A |
| 3 | Venue JSON + `filterVenues` | B owns, A calls |
| 4 | Merged constraints `{budgetCapUSD, requiredDietary[], window}` | B→A |
| 5 | Candidate plan `{roundId, candidates:[{venueId,time,estCostUSD}]}` | A produces; **sends in DMs** |
| 6 | Evaluation `{venueId, pass, score, needsMyHuman?}` | B→A |
| 7 | `rounds` document shape | A writes, B reads |
| 8 | `users` / `plans` | A: joinCode, participants, status, activePlanId; B: slots |
| 9 | Nessie anchor → `budgetCapUSD` | A→B |

Contract 7: fake rounds are enough to build the screen with no orchestrator and no Spectrum.
Contract 8 failure mode: A's join clobbering seeded `users.profile`.
Photon never participates in 8.

## Order of work

1. Contracts + resolvers (done on `main`).
2. Venues, aggregator, travel, filter, agents, harness (done).
3. Backroom against fake rounds; swap to live `listRounds` when A appends.
4. Stay available for `handleDM` copy / extraction if A’s shared-plan JOIN needs a “you’re in” line — prefer A sending that string and only then calling `handleDM`, so B still does not parse JOIN.
5. Stretch: privacy-safe backroom advocacy overlay, not a new merge protocol.

## Verification

- `npm run harness` — three fake users, resolved slots, merged constraints, survivors, scores, chosen plan. **This remains the 7pm checkpoint** and does not use iMessage groups.
- Resolver cases: `"WTC"`, `"133 W 3rd St"`, `"near Union Square"`, `"Bushwick"`; `"I can eat everything"` → `[]`; `"cheap"` → a number.
- Unresolvable dietary (`"I only eat purple food"`) must not zero survivors via the hard filter.
- Privacy: merged object keys are exactly `budgetCapUSD`, `requiredDietary`, `window`.
- Survivor count with three demo profiles in 6–17 of 50.
- `npm run backroom` — fake rounds render.
- End-to-end (A’s 9pm): three **DMs**, not a bot in the group. B watches the backroom; A owns JOIN and card fan-out.
