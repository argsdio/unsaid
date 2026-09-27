import type {
  Concession,
  MergedConstraints,
  NegotiationResult,
  Objection,
  Position,
  Rejection,
  RequiredSlot,
  RoundLog,
  Survivor,
} from "./contracts.ts";
import { type Participant, hasOverlap, mergeConstraints, travelProfiles } from "./aggregator.ts";
import { scoreCandidates } from "./agent/score.ts";
import type { Occasion, SavedNegotiation } from "./contracts.ts";
import type { Store } from "./db.ts";
import { VENUES, filterVenues, mealsFor, venueById } from "./venues.ts";

// A venue is accepted when it clears this for a person. Set so a first round
// rarely settles outright: the whole point is that somebody has to move.
const ACCEPT_FLOOR = 0.35;
const MAX_ROUNDS = 3;

// How far a willing person stretches per round.
const BUDGET_STEP = 10;
const TRAVEL_STEP = 15;

type Agent = {
  userId: string;
  participant: Participant;
  tastes: string[];
  preferredSpots: string[];
  sensitive: RequiredSlot[];
};

function cap(agent: Agent, slot: "budgetCapUSD" | "maxTravelMin"): number | null {
  return agent.participant.slots[slot]?.value ?? null;
}

function flex(agent: Agent, slot: "budgetCapUSD" | "maxTravelMin", value: number): Agent {
  return {
    ...agent,
    participant: {
      ...agent.participant,
      slots: {
        ...agent.participant.slots,
        [slot]: { raw: "(flexed)", value, confidence: "low" },
      },
    },
  };
}

// Rejection counts cannot rank constraints, because filterVenues attributes each
// venue to the FIRST check it fails and budget is checked first. A tight budget
// therefore hogs the count even when travel is what is actually binding -- which
// is how an early version bumped the budget three times while nobody could reach
// anywhere.
//
// The honest measure is counterfactual: relax one constraint by a single step and
// count how many more venues survive. That ranks by what would actually help.
function rankedObjections(
  rejected: Array<{ failedOn: string }>,
  merged: MergedConstraints,
): Objection[] {
  const counts = new Map<string, number>();
  for (const r of rejected) counts.set(r.failedOn, (counts.get(r.failedOn) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .flatMap<Objection>(([category]) => {
      if (category === "budget") return [{ kind: "budget", cap: merged.budgetCapUSD }];
      if (category === "travel") return [{ kind: "travel", maxMin: 0 }];
      const tag = merged.requiredDietary[0];
      return category === "dietary" && tag ? [{ kind: "dietary", tag }] : [];
    });
}

function describe(objection: Objection | null): string {
  if (!objection) return "nothing obvious";
  if (objection.kind === "budget") return `budget, capped at $${objection.cap}`;
  if (objection.kind === "travel") return "how far people will travel";
  if (objection.kind === "occasion") return `too few places for ${objection.occasion}`;
  return `a ${objection.tag} requirement`;
}

// Rendered from typed data, never written by a model -- prose from an LLM here
// would carry the identifying detail the types exist to strip.
function narrate(
  round: number,
  survivors: number,
  settledOn: string | undefined,
  objection: Objection | null,
  concessions: Concession[],
): string {
  if (settledOn) {
    return `Round ${round}: agreed on ${venueById(settledOn)?.name ?? settledOn}.`;
  }
  const head =
    survivors === 0
      ? `Round ${round}: nothing clears everyone's limits yet.`
      : `Round ${round}: ${survivors} option${survivors === 1 ? "" : "s"} on the table, no agreement.`;
  const why = ` The sticking point is ${describe(objection)}.`;
  if (concessions.length === 0) return `${head}${why} Nobody can move.`;
  // Deduped: several people holding the same tightest cap all offer the same
  // number, and "up to 35 min, up to 35 min, up to 35 min" reads like a bug.
  const offers = [
    ...new Set(
      concessions.map((c) => (c.kind === "budget" ? `$${c.newCap}` : `${c.newMaxMin} min`)),
    ),
  ];
  const who = concessions.length > 1 ? `${concessions.length} people can` : "Someone can";
  return `${head}${why} ${who} stretch to ${offers.join(" or ")}.`;
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Budget and travel can be relaxed; dietary cannot. So if lifting both of them
// entirely still leaves nothing, no amount of flexing will help and the real
// blocker is the dietary set. Saying "the clash is budget" there sends people to
// raise a number that was never the problem.
function trueBlocker(
  agents: Agent[],
  day: Date,
  occasion: Occasion,
  fallback: Objection | null,
): Objection | null {
  const unlimited = agents.map((a) => flex(flex(a, "budgetCapUSD", 100000), "maxTravelMin", 100000));
  if (survivorCount(unlimited, day, occasion) > 0) return fallback;
  // Nothing survives even with money and distance lifted, so the wall is one of
  // the two constraints that never bend. Drop dietary too: if places appear, the
  // dietary set was the wall; if they still do not, this occasion has nowhere to
  // go and blaming a person's diet for a thin catalogue would be wrong.
  const undieted = unlimited.map((a) => ({
    ...a,
    participant: { ...a.participant, slots: { ...a.participant.slots, dietary: undefined } },
  }));
  // No catalogue for this kind of outing at all: nobody's constraint is at fault
  // and no amount of flexing helps, so say that instead of naming a person's diet.
  if (!VENUES.some((v) => mealsFor(v).includes(occasion))) return { kind: "occasion", occasion };
  if (survivorCount(undieted, day, occasion) > 0) {
    const tag = mergeConstraints(unlimited.map((a) => a.participant), day, occasion).requiredDietary[0];
    if (tag) return { kind: "dietary", tag };
  }
  return fallback;
}

function survivorCount(agents: Agent[], day: Date, occasion: Occasion): number {
  const parts = agents.map((a) => a.participant);
  return filterVenues(VENUES, mergeConstraints(parts, day, occasion), travelProfiles(parts), occasion)
    .survivors.length;
}

// One step of relaxation applied to whoever holds the tightest cap, but only if
// they did not hedge about it. Returns null when nobody is willing.
function relaxedBy(
  agents: Agent[],
  kind: "budget" | "travel",
): { agents: Agent[]; concessions: Concession[] } | null {
  const slot = kind === "budget" ? "budgetCapUSD" : "maxTravelMin";
  const tightest = Math.min(...agents.map((a) => cap(a, slot) ?? Infinity));
  if (!Number.isFinite(tightest)) return null;

  const holders = agents.filter(
    (a) => (cap(a, slot) ?? Infinity) === tightest && !a.sensitive.includes(slot),
  );
  if (holders.length === 0) return null;

  const step = kind === "budget" ? BUDGET_STEP : TRAVEL_STEP;
  const concessions: Concession[] = holders.map((h) =>
    kind === "budget"
      ? { kind: "budget", newCap: (cap(h, slot) ?? 0) + step }
      : { kind: "travel", newMaxMin: (cap(h, slot) ?? 0) + step },
  );
  const ids = new Set(holders.map((h) => h.userId));
  return {
    agents: agents.map((a) => (ids.has(a.userId) ? flex(a, slot, tightest + step) : a)),
    concessions,
  };
}

// Whichever willing relaxation admits the most venues, preferring one that helps
// immediately but accepting one that does not.
//
// A single step often cannot close the gap on its own -- 20 to 35 minutes still
// will not get someone from Harlem to the West Village -- and giving up there
// would end a negotiation that two more steps would have settled. So gain 0 is
// still progress while rounds remain. Deadlock means nobody is WILLING to move,
// never that one step was not enough.
function bestRelaxation(
  agents: Agent[],
  day: Date,
  occasion: Occasion,
  baseline: number,
): { agents: Agent[]; concessions: Concession[]; kind: "budget" | "travel"; gain: number } | null {
  let best: { agents: Agent[]; concessions: Concession[]; kind: "budget" | "travel"; gain: number } | null =
    null;
  for (const kind of ["budget", "travel"] as const) {
    const relaxed = relaxedBy(agents, kind);
    if (!relaxed) continue;
    const gain = survivorCount(relaxed.agents, day, occasion) - baseline;
    if (!best || gain > best.gain) {
      best = { agents: relaxed.agents, concessions: relaxed.concessions, kind, gain };
    }
  }
  return best;
}

// Shaped as RoundLog so A appends it unchanged and the backroom screen keeps its
// score bars, while gaining the narration and the objections.
function toRoundLog(
  planId: string,
  round: number,
  survivors: Survivor[],
  rejected: Rejection[],
  positions: Position[][],
  objections: Objection[],
  concessions: Concession[],
  narration: string,
  settledOn?: string,
): RoundLog {
  const scoresFor = (venueId: string) =>
    positions.map((list) => list.find((p) => p.venueId === venueId)?.score ?? 0);
  return {
    planId,
    round,
    at: new Date().toISOString(),
    narration,
    objections,
    concessions,
    ...(settledOn ? { settledOn } : {}),
    candidates: [
      ...survivors.map((s) => ({
        venueId: s.venueId,
        passed: positions.every(
          (list) => list.find((p) => p.venueId === s.venueId)?.move === "accept",
        ),
        scores: scoresFor(s.venueId),
      })),
      ...rejected.map((r) => ({
        venueId: r.venueId,
        passed: false,
        failedOn: r.failedOn,
        scores: [] as number[],
      })),
    ],
  };
}

async function positionsFor(agents: Agent[], survivors: Survivor[]): Promise<Position[][]> {
  return Promise.all(
    agents.map(async (agent) => {
      const evaluations = await scoreCandidates(survivors, {
        slots: agent.participant.slots,
        tastes: agent.tastes,
        preferredSpots: agent.preferredSpots,
      });
      return evaluations.map<Position>((e) => ({
        venueId: e.venueId,
        move: e.pass && e.score >= ACCEPT_FLOOR ? "accept" : "hold",
        score: e.score,
      }));
    }),
  );
}

const SHORTLIST = 3;

// Best worst-case first, tiebroken by the shorter longest commute. Returns up to
// three: one option is a decision handed down, three is a choice.
function rank(survivors: Survivor[], positions: Position[][], limit: number): string[] {
  const travel = new Map(survivors.map((s) => [s.venueId, s.longestTravelMin]));
  return survivors
    .map((s) => ({
      venueId: s.venueId,
      worst: Math.min(...positions.map((l) => l.find((p) => p.venueId === s.venueId)?.score ?? 0)),
    }))
    .sort(
      (a, b) => b.worst - a.worst || (travel.get(a.venueId) ?? 0) - (travel.get(b.venueId) ?? 0),
    )
    .slice(0, limit)
    .map((x) => x.venueId);
}

function acceptedByAll(survivors: Survivor[], positions: Position[][]): Survivor[] {
  return survivors.filter((s) =>
    positions.every((list) => list.find((p) => p.venueId === s.venueId)?.move === "accept"),
  );
}

// Layer 4. Somebody who hedged about a constraint is the only one who could help.
// They are never silently conceded on their behalf -- they get asked, privately,
// once, with an easy way to decline.
function whisperCandidate(
  agents: Agent[],
  day: Date,
  occasion: Occasion,
  baseline: number,
  asked: string[],
): { userId: string; kind: "budget" | "travel"; newValue: number; question: string } | null {
  for (const kind of ["budget", "travel"] as const) {
    const slot = kind === "budget" ? "budgetCapUSD" : "maxTravelMin";
    const tightest = Math.min(...agents.map((a) => cap(a, slot) ?? Infinity));
    if (!Number.isFinite(tightest)) continue;

    const step = kind === "budget" ? BUDGET_STEP : TRAVEL_STEP;
    const candidates = agents.filter(
      (a) =>
        (cap(a, slot) ?? Infinity) === tightest &&
        a.sensitive.includes(slot) &&
        !asked.includes(a.userId),
    );

    for (const candidate of candidates) {
      const relaxed = agents.map((a) =>
        a.userId === candidate.userId ? flex(a, slot, tightest + step) : a,
      );
      if (survivorCount(relaxed, day, occasion) - baseline < 0) continue;
      const newValue = tightest + step;
      const question =
        kind === "budget"
          ? `Everything that works for the group is a bit over $${tightest}. Could you do $${newValue}? Completely fine to say no — I'll find something else.`
          : `The options that work are a bit further out — about ${newValue} min instead of ${tightest}. Okay? Completely fine to say no.`;
      return { userId: candidate.userId, kind, newValue, question };
    }
  }
  return null;
}

// yes / no, with null for anything we cannot read -- treated as a no, since
// pushing someone who did not clearly agree is the thing to avoid.
export function parseAgreement(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (/^(y|ya|yes|yeah|yep|yup|ok|okay|sure|fine|works|deal|go ahead|do it|thats fine|that works|i can|can do)\b/.test(t)) {
    return true;
  }
  if (/^(n|no|nope|nah|cant|can not|cannot|sorry|rather not|id rather not|too much|not really)\b/.test(t)) {
    return false;
  }
  return null;
}

type Relaxations = Record<string, { budget?: number; travel?: number }>;

async function loadAgents(
  store: Store,
  people: Participant[],
  relaxations: Relaxations,
): Promise<Agent[]> {
  return Promise.all(
    people.map(async (participant) => {
      const user = await store.getUser(participant.userId);
      const applied = relaxations[participant.userId];
      let slots = participant.slots;
      if (applied?.budget !== undefined) {
        slots = { ...slots, budgetCapUSD: { raw: "(flexed)", value: applied.budget, confidence: "low" } };
      }
      if (applied?.travel !== undefined) {
        slots = { ...slots, maxTravelMin: { raw: "(flexed)", value: applied.travel, confidence: "low" } };
      }
      return {
        userId: participant.userId,
        participant: { ...participant, slots },
        tastes: user?.profile.tastes ?? [],
        preferredSpots: user?.profile.preferredSpots ?? [],
        sensitive: participant.slots.sensitive ?? [],
      };
    }),
  );
}

/**
 * Contract 12. Rounds, unattributed objections, agents that decide their own
 * movement (layers 1-3), and a private ask when the only person who could help
 * is the one who sounded uncomfortable (layer 4).
 *
 * Resumes automatically from a saved pause, so the caller does not need to know
 * whether this is a fresh run or a continuation.
 */
export async function negotiate(
  store: Store,
  planId: string,
  people: Participant[],
  day: Date = new Date(),
): Promise<NegotiationResult> {
  const occasion = (await store.getPlan(planId))?.occasion ?? "dinner";
  const saved = await store.getNegotiation(planId);
  const relaxations: Relaxations = { ...(saved?.relaxations ?? {}) };
  const askedAlready = [...(saved?.asked ?? [])];
  let agents = await loadAgents(store, people, relaxations);

  const rounds: RoundLog[] = [];
  let lastObjection: Objection | null = null;

  const done = async <T extends NegotiationResult>(result: T): Promise<T> => {
    await store.clearNegotiation(planId);
    return result;
  };

  for (let round = saved?.round ?? 1; round <= MAX_ROUNDS; round++) {
    const parts = agents.map((a) => a.participant);
    const merged = mergeConstraints(parts, day, occasion);
    if (!hasOverlap(merged.window)) {
      return done({ status: "failed", reason: "no-overlap", binding: null, merged, rounds });
    }

    const filtered = filterVenues(VENUES, merged, travelProfiles(parts), occasion);
    const ranked = rankedObjections(filtered.rejected, merged);
    const objection = ranked[0] ?? null;
    lastObjection = objection;

    const positions =
      filtered.survivors.length > 0 ? await positionsFor(agents, filtered.survivors) : [];
    const accepted =
      filtered.survivors.length > 0 ? acceptedByAll(filtered.survivors, positions) : [];

    if (accepted.length > 0) {
      const shortlist = rank(accepted, positions, SHORTLIST);
      rounds.push(
        toRoundLog(
          planId, round, filtered.survivors, filtered.rejected, positions, [], [],
          narrate(round, filtered.survivors.length, shortlist[0], objection, []),
          shortlist[0],
        ),
      );
      return done({ status: "settled", shortlist, merged, rounds });
    }

    // Somebody willing? Take the relaxation that admits the most venues.
    const relaxation = bestRelaxation(agents, day, occasion, filtered.survivors.length);
    if (relaxation) {
      agents = relaxation.agents;
      for (const a of agents) {
        const budget = cap(a, "budgetCapUSD");
        const travel = cap(a, "maxTravelMin");
        const before = relaxations[a.userId] ?? {};
        const originalBudget = people.find((p) => p.userId === a.userId)?.slots.budgetCapUSD?.value;
        const originalTravel = people.find((p) => p.userId === a.userId)?.slots.maxTravelMin?.value;
        if (budget !== null && budget !== originalBudget) before.budget = budget;
        if (travel !== null && travel !== originalTravel) before.travel = travel;
        if (Object.keys(before).length > 0) relaxations[a.userId] = before;
      }
      const asked: Objection =
        relaxation.kind === "budget"
          ? { kind: "budget", cap: merged.budgetCapUSD }
          : { kind: "travel", maxMin: 0 };
      rounds.push(
        toRoundLog(
          planId, round, filtered.survivors, filtered.rejected, positions,
          shuffle(objection ? [objection] : []), relaxation.concessions,
          narrate(round, filtered.survivors.length, undefined, asked, relaxation.concessions),
        ),
      );
      continue;
    }

    // Nobody willing. If the only person who could help hedged about it, ask them
    // privately rather than either pushing them silently or giving up.
    const whisper = whisperCandidate(agents, day, occasion, filtered.survivors.length, askedAlready);
    if (whisper) {
      rounds.push(
        toRoundLog(
          planId, round, filtered.survivors, filtered.rejected, positions,
          shuffle(objection ? [objection] : []), [],
          `${narrate(round, filtered.survivors.length, undefined, objection, [])} Checking privately with the one person who could move.`,
        ),
      );
      await store.saveNegotiation({
        planId,
        round,
        relaxations,
        asked: askedAlready,
        pendingAsk: {
          userId: whisper.userId,
          question: whisper.question,
          kind: whisper.kind,
          newValue: whisper.newValue,
        },
      });
      return { status: "waiting", userId: whisper.userId, question: whisper.question, merged, rounds };
    }

    rounds.push(
      toRoundLog(
        planId, round, filtered.survivors, filtered.rejected, positions,
        shuffle(objection ? [objection] : []), [],
        narrate(round, filtered.survivors.length, undefined, objection, []),
      ),
    );

    if (filtered.survivors.length > 0) {
      const shortlist = rank(filtered.survivors, positions, SHORTLIST);
      return done({ status: "settled", shortlist, merged, rounds });
    }
    return done({
        status: "failed",
        reason: "deadlock",
        binding: trueBlocker(agents, day, occasion, objection),
        merged,
        rounds,
      });
  }

  const parts = agents.map((a) => a.participant);
  const finalMerged = mergeConstraints(parts, day, occasion);
  const filtered = filterVenues(VENUES, finalMerged, travelProfiles(parts), occasion);
  if (filtered.survivors.length > 0) {
    const positions = await positionsFor(agents, filtered.survivors);
    const shortlist = rank(filtered.survivors, positions, SHORTLIST);
    return done({ status: "settled", shortlist, merged: finalMerged, rounds });
  }
  return done({
    status: "failed",
    reason: "round-cap",
    binding: trueBlocker(agents, day, occasion, lastObjection),
    merged: finalMerged,
    rounds,
  });
}

/**
 * The other half of layer 4: a person answered their agent's private question.
 * Agreement applies exactly the number they were shown; anything else is treated
 * as a no and they are never asked again this plan.
 */
export async function resumeNegotiation(
  store: Store,
  planId: string,
  people: Participant[],
  text: string,
  day: Date = new Date(),
): Promise<NegotiationResult> {
  const saved = await store.getNegotiation(planId);
  if (!saved?.pendingAsk) return negotiate(store, planId, people, day);

  const { userId, kind, newValue } = saved.pendingAsk;
  const agreed = parseAgreement(text) === true;

  await store.saveNegotiation({
    planId,
    round: saved.round + 1,
    relaxations: agreed
      ? {
          ...saved.relaxations,
          [userId]: {
            ...(saved.relaxations[userId] ?? {}),
            ...(kind === "budget" ? { budget: newValue } : { travel: newValue }),
          },
        }
      : saved.relaxations,
    // Recorded either way: one private ask per person per plan.
    asked: [...saved.asked, userId],
    pendingAsk: undefined,
  });

  return negotiate(store, planId, people, day);
}
