# Unsaid — negotiation protocol and contract 12

**Status: proposed. No code exists.** `src/contracts.ts` on `main` is unchanged; every signature in the two lane plans is still accurate. This document specifies the design so it can be checked before anything is built, and so A knows the one thing in her plan that must change regardless.

Owner: B, behind two functions. A imports nothing new except the result type.

## Why this shape

Each person's preferences are represented by an agent, and **the agent is the mask**. The aggregator converses with masks, so it cannot address a person even if it wanted to — it can only address a constraint. The privacy guarantee stops being a rule someone has to remember and becomes a property of who talks to whom.

This is the same boundary `mergeConstraints` already draws, made conversational and multi-turn.

## Participants

```
sub-environment = planId
  ├── agent(maya)   persona + private prefs + negotiation memory   ─┐
  ├── agent(dev)    persona + private prefs + negotiation memory    ├─ private, never shared
  ├── agent(priya)  persona + private prefs + negotiation memory   ─┘
  └── aggregator    sees positions and objections. Never names, never slots.
```

Personas are built from **taste words and writing style only** — never from constraint values. An agent told "you are frugal" because its person has a $25 cap re-identifies that cap through its own voice.

## Layers

Each works without the next, so the ambitious part cannot sink the rest.

| Layer | Adds | Synchronous? |
|---|---|---|
| 1 | Personas and multi-turn positions | yes |
| 2 | Aggregator re-prompts when nothing is unanimous | yes |
| 3 | Agents decide movement themselves, using the sensitivity signal | yes |
| 4 | Real human consult — the negotiation pauses on an inbound DM | **no** |

Layers 1–3 give visible advocacy and concession with no async machinery and **no change to A's responsibilities** beyond the deadlock fix below. Layer 4 is where LangGraph's `interrupt` plus a checkpointer earns its place, and it is the only layer that changes A's work.

## The wire protocol

Typed moves, never prose. If agents exchanged natural language the model would leak the reason inside two turns — "I can't, it's out of my range." Prose exists only in the narration rendered *from* these types for the backroom screen.

```ts
type Objection =
  | { kind: "budget";  cap: number }
  | { kind: "dietary"; tag: DietaryTag }
  | { kind: "travel";  maxMin: number };

// Dietary is absent on purpose. A dietary need is not a preference and is
// never asked to bend; only budget and travel can move.
type Concession =
  | { kind: "budget"; newCap: number }
  | { kind: "travel"; newMaxMin: number };

type Position = {
  venueId: string;
  move: "accept" | "hold" | "canMove" | "askMyHuman";
  score: number;             // 0..1, graded, always present
  objection?: Objection;     // absent only on accept
  concession?: Concession;   // present on canMove
  question?: string;         // present on askMyHuman, rendered for the person
};
```

`Position` has **no `agent` and no `userId`**, and the aggregator receives positions **shuffled**, so array order cannot be read as identity.

```ts
type AggregatorTurn = {
  round: number;
  proposals: Candidate[];          // what is on the table
  bindingObjections: Objection[];  // anonymised, from the previous round
  ask: "position" | "movement";
  narration: string;               // for the screen
};
```

## A round

```
1. aggregator proposes a set of candidates and asks for positions
2. each agent returns one Position per candidate, in parallel, one call per agent
3. any venue with all-accept  -> settled
4. otherwise the aggregator collects the objection multiset, states the binding
   constraint anonymously, and asks for movement
5. agents reply hold / canMove / askMyHuman
6. askMyHuman -> pause (layer 4). Otherwise re-filter against concessions, repeat
```

## Termination — four exits, all guaranteed

| Exit | Condition |
|---|---|
| **settled** | every position on one venue is `accept` |
| **deadlock** | every agent `hold`s with no concession and no `askMyHuman` — fail immediately rather than burning rounds |
| **roundCap** | `MAX_ROUNDS = 3` reached → fall back to best-worst-case over the last round's scores |
| **paused** | any `askMyHuman` → interrupt, hand the question to A |

`select()` remains the final arbiter, so the demo cannot hang. Note that `deadlock` and `roundCap` both still produce a plan via maximin — they are not user-visible failures.

## Contract 12 — the A ↔ B interface

```ts
type NegotiationResult =
  | { status: "settled"; chosen: Candidate; rounds: RoundLog[] }
  | { status: "waiting"; userId: string; question: string }
  | { status: "failed";  reason: "deadlock" | "roundCap" };

negotiate(planId: string, people: Participant[]): Promise<NegotiationResult>
resumeNegotiation(planId: string, userId: string, text: string): Promise<NegotiationResult>
```

Two plain in-process async functions. **A imports nothing from LangChain**; any framework lives inside these.

### Pause and resume

1. `negotiate` returns `waiting` with a `userId` and a question. B has already persisted the negotiation state.
2. A sends that question to that person's line and parks. She changes no status.
3. That person's reply arrives as an ordinary inbound DM. A must route it to `resumeNegotiation`, **not** `handleDM`.
4. `resumeNegotiation` returns the same union — it may return `waiting` again for a different person.
5. On `settled` or `failed`, A proceeds to the plan card as normal.

### Storage boundary

LangGraph's checkpointer, if used, writes to its own MongoDB collection. The `plans` document remains the source of truth for lifecycle and `status` stays A's. Checkpoints are opaque to A.

## What is code and what is a model

| Job | Code or LLM |
|---|---|
| Merge, filter, travel, maximin, termination | **always code** |
| Position decision (accept / hold / canMove) | code first, from score thresholds plus the sensitivity signal |
| Which candidate to propose next | LLM, with next-best-by-maximin as the fallback |
| Persona voice and narration phrasing | LLM, from typed data only |

## Privacy invariants, and the tests that enforce them

The invariant moves from "no reasons" to **"no attribution"**. Write these as assertions before writing the protocol:

1. No `Position` object has an `agent` or `userId` key.
2. `Objection` and `Concession` carry no free-text field.
3. Positions are shuffled before the aggregator sees them — order is not identity.
4. The aggregator's prompt payload contains only `proposals`, `bindingObjections` and round history. Never slots, never names, never raw text.
5. A persona string is derived only from `tastes` and writing style, never from a constraint value.
6. No `Concession` is ever emitted with `kind: "dietary"`.

Invariant 4 is the one that fails silently and matters most.

## What changes for A

Only layer 4 touches her, and in one place: the agent's question goes out through her message loop and the answer comes back through it.

| A gains | |
|---|---|
| A fifth router branch | has plan + status `negotiating` + a pending question for this sender → `resumeNegotiation` |
| Tolerating a paused negotiation | some input during `negotiating` is load-bearing, not noise |
| Delivering the whisper | B composes the question, A sends it to that person's line |
| No restart or timeout while paused | `negotiating` must sit still |

| A loses | |
|---|---|
| The round loop | B owns rounds, because the checkpoint state is B's |

## Open questions

- **If the person never replies**, how long does the negotiation sit paused? A timeout that forces that agent's position to `hold` is the obvious answer, but the duration is A's call and it needs a value before the demo.
- Does the aggregator narrate every round, or only rounds where something changed? Every round is noisier but reads better on a projector.
- `MAX_ROUNDS = 3` is a guess. Two may be enough with only three people.
