# Unsaid — teammate B lane: contracts, resolvers, scaffold

## Context

DivHacks build night, 4pm–12am. The shared build plan doc (`claude.ai/code/artifact/4079210e-b03b-47b6-83ee-74fe82d6c0ef`, now at rev 17) splits work two ways: A owns messaging and flow (Spectrum, router, join link, orchestrator, Nessie), B owns agents, data and screen (Grok extraction and scoring, aggregator, venues, backroom screen). A's lane is in `plan-teammate-a.md` in this folder.

Three problems block B from starting:

1. **The repo is empty.** `src/index.ts` is the `create-spectrum-project` echo loop; dependencies are only `spectrum-ts` and `dotenv`. No Mongo driver, no Grok client, no venue data, no contract types.
2. **The doc names four A↔B contracts, but nine exist**, and one of the four (Constraints: personal agent → aggregator) is internal to B, not a cross-boundary contract at all. The doc says to agree shapes "by 5pm so everyone can build in parallel against fake data" — that can't happen against an incomplete list.
3. **The venue count contradicts itself** across three places (25–30 in the MVP checklist, ~50 in Architecture, 50 in the risk table), and B owns venues.

Intended outcome: contracts settled and typed, B's lane runnable end-to-end against three fake users with no dependency on A (the doc's 7pm checkpoint), and the doc corrected so the 5pm agreement is against one accurate list.

**Assumption to confirm at 4pm:** one shared repo, A imports `src/contracts.ts` directly so the compiler catches contract drift. If A works in a separate repo, that file is hand-copied and nothing enforces it — worth 30 seconds to decide.

## Decisions settled this turn

### Slot schema: free text in, resolved values out — no closed enums at extraction

Closed vocabularies at the extraction boundary were wrong. People say "WTC", "133 W 3rd St", "near Union Square", "I can eat everything", "nothing too expensive". Forcing Grok to emit an enum member turns all of that into a guess or a parse failure.

Every constrained slot carries **both** layers, and resolution happens in code after extraction:

```ts
type Slot<T> = {
  raw: string;            // verbatim, what they typed
  value: T | null;        // resolved, null = could not resolve
  confidence: "high" | "low";
};
```

Tri-state matters: slot absent = never asked, `value: []`/`0` = answered with "no restrictions", `value: null` + `raw` present = answered but unresolved. Without it the agent re-asks someone who already said "I eat everything."

**Neighborhoods become coordinates.** The filter never needed a category — it needs travel time, which needs a point. Resolution ladder: a hand-built gazetteer of ~40 NYC neighborhood and landmark aliases → `{lat, lng}`; miss → one Grok call for the coordinates of a named NYC location; miss → borough centroid with `confidence: "low"`. Venues already carry `lat`/`lng`, so distance is uniform and "WTC" works as naturally as "Bushwick".

**Dietary resolves through a synonym map, and "none" is a real value.** `veggie|no meat|vegetarian` → `vegetarian`; `i can eat everything|no restrictions|anything|not picky|nope` → `[]`. Unmatched text stays in `raw`, lands in `unresolved[]`, and is **demoted to a soft scoring signal rather than a hard filter** — so an unrecognized phrase can never zero out the survivor set. That is the single most important safety property in the resolver layer.

Same pattern for budget ("cheap", "under like 30") and `maxTravelMin` ("I don't want to go far"). `tags` and `namedSpots` stay free text permanently — they are soft, scored by an LLM, and never need canonicalising; a named spot not in the catalog is matched fuzzily and otherwise ignored as taste signal.

### Venue filtering: B owns it, A calls it

B owns both of the filter's inputs (the venue JSON and the aggregator's merged constraints) and needs filtering for scoring regardless. Decisive argument: the 7pm checkpoint is B's terminal run producing a plan, which is impossible if filtering lives in A's orchestrator. A still *drives* — decides when to filter, reads the survivor count, branches to the flex whisper — it just doesn't implement. This overrides the doc's Architecture row assigning filtering to the orchestrator.

### Travel time: enforced, and it never reaches A

Travel *is* a hard filter — but it belongs inside B's filter, not in merged constraints. An unlabeled `maxTravelMin: [20, 30, 45]` is unusable to A anyway: computing anyone's commute requires their home coordinates, so A would need the private data the contract exists to withhold.

Because B owns the filter and the home coordinates, travel is enforced as a pre-filter there, and each survivor carries one aggregate number:

```ts
{ venueId: string, longestTravelMin: number }   // whose commute is unlabeled
```

A applies "minimize the longest commute" directly from `longestTravelMin`, with no homes, no caps, and no per-person commute times.

This supersedes what I said last turn: I had travel returning per-person as `travelMin` on each Evaluation, which would have let A infer individual commutes. The aggregate is both simpler and strictly better on privacy, and it removes the leak I had flagged as unavoidable. **Evaluation no longer carries `travelMin`.**

## Doc updates — APPLIED (rev 11 → 17)

These are done in the shared doc already; listed so A can see what changed.

| Location | Change |
|---|---|
| MVP checklist, "25–30 curated venues" | → 50 |
| Architecture, "~50 hand-curated NYC venues (price, tags, hours, coordinates)" | → 50, 7-field schema, `hours` dropped (demo scope is one evening) |
| Architecture, Venue data row | note filter is B's pure function, called by the orchestrator |
| Data model, Contracts table | 4 rows → 9, each with owner, direction and deadline |
| Contracts, Merged constraints | drop per-person max travel; three group fields only |
| Contracts, Evaluation | drop `travelMin`; add `needsMyHuman` |
| User flow / Collect step | 15 seeded preferences per demo user, in the `users` standing profile |
| 5–7pm row, "start 25–30 venue JSON" | → 50 |

Risk table already reads 50; leave it.

## Code scaffold

New dependencies: `mongodb`, `openai` (pointed at `https://api.x.ai/v1` for Grok), `express` for the backroom page.

```
src/
  contracts.ts        Slot<T>, slot schema, the 9 wire types. A imports this.
  resolve/
    gazetteer.ts      ~40 NYC alias -> {lat,lng}
    location.ts       resolveHome(raw) -> Slot<{lat,lng,label}>
    dietary.ts        synonym map, "none" handling, unresolved[] -> soft
    money.ts          "cheap" / "under 30" -> Slot<number>
  venues.json         50 x {id,name,estCostUSD,tags[],neighborhood,lat,lng}
  venues.ts           filterVenues(venues, merged, homes)
                        -> { survivors: [{venueId, longestTravelMin}],
                             rejected:  [{venueId, failedOn}] }
  travel.ts           haversine + NYC transit estimate (fixed overhead + per-km)
  aggregator.ts       mergeConstraints(slots[]) -> MergedConstraints
  agent/
    extract.ts        DM text -> raw slots (Grok structured output)
    score.ts          candidates -> pass/fail + score 0..1 + needsMyHuman
  db.ts               users / plans / rounds collections
  backroom/
    server.ts         express, reads rounds
    page.html         live view for the projector
  harness.ts          3 fake users, no Spectrum, no A
```

`src/index.ts` stays the echo loop until A wires the router; `handleDM` is the seam.

Scoring must be **graded, not binary** — best-worst-case selection over 1.0/0.0 scores ties at zero and makes A's picker arbitrary. Named spot ~0.9, tag match 0.5–0.7, minus a travel penalty.

`rejected[].failedOn` is a category (`"budget"`, `"dietary"`, `"window"`, `"travel"`), never a person or a reason — it feeds the backroom crossouts and stays privacy-safe because merged constraints are already group-level.

## The nine contracts

| # | Contract | Direction | Settle by |
|---|---|---|---|
| 1 | Slot schema + resolvers (`Slot<T>`, tri-state) | shared | 4pm |
| 2 | Inbound DM handoff `handleDM({planId,userId,text}) -> {slots,missing[],reply}` | A→B→A | 4pm |
| 3 | Venue JSON + `filterVenues` | B owns, A calls | 4pm |
| 4 | Merged constraints `{budgetCapUSD, requiredDietary[], window}` | B→A | 5pm |
| 5 | Candidate plan `{roundId, candidates:[{venueId,time,estCostUSD}]}` | A→B | 5pm |
| 6 | Evaluation `{venueId, pass, score, needsMyHuman?}` | B→A | 5pm |
| 7 | `rounds` document shape | A writes, B reads | 5pm |
| 8 | `users` / `plans` ownership split | A creates, B fills slots | 5pm |
| 9 | Nessie anchor → `budgetCapUSD` | A→B | 9pm |

Contract 7 is B's decoupling seam: agree the shape, hand-write two fake rounds, build the whole screen with no orchestrator and no Spectrum.
Contract 8's failure mode is A's join flow clobbering the 15 seeded preferences in `users`.

## Order of work

1. Doc edits (~5 min), so the 5pm agreement is against the corrected list.
2. `contracts.ts` + resolvers with A in the room (20 min), then split.
3. `venues.json` — generate 50 against the 7-field schema, spot-check prices on the dozen most likely to appear (~20 min, not 90).
4. `aggregator.ts`, `travel.ts`, `venues.ts`, then `agent/`.
5. `harness.ts` → hits the 7pm checkpoint.
6. `backroom/` against fake rounds.
7. Wire to A's router via `handleDM`.

## Verification

- `npx tsx src/harness.ts` — three fake users with conflicting constraints, printing resolved slots, merged constraints, survivor count, per-person scores and the chosen plan. This *is* the 7pm checkpoint and needs neither Spectrum nor A.
- Resolver cases, asserted in the harness: `"WTC"`, `"133 W 3rd St"`, `"near Union Square"`, `"Bushwick"` all resolve to plausible coordinates; `"I can eat everything"`, `"not picky"` → `[]`; `"cheap"` → a number.
- **Safety assertion:** an unresolvable dietary phrase (`"I only eat purple food"`) must leave the survivor count unchanged, proving unresolved text degrades to soft scoring.
- **Privacy assertion:** the object handed to the orchestrator has exactly the keys `budgetCapUSD`, `requiredDietary`, `window` — fail the test on any extra key, so a future edit can't quietly leak a per-person field.
- Survivor count with three realistic demo profiles should land in 6–17 of 50. Below ~5, loosen the catalog's price spread rather than the filter.
- `npm run backroom` — seeded fake rounds render and update live.
- End-to-end in a real iMessage group once A's router is up (9pm checkpoint, three phones).
