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
import type { Store } from "./db.ts";
import { VENUES, filterVenues, venueById } from "./venues.ts";

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

function survivorCount(agents: Agent[], day: Date): number {
  const parts = agents.map((a) => a.participant);
  return filterVenues(VENUES, mergeConstraints(parts, day), travelProfiles(parts)).survivors.length;
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
  baseline: number,
): { agents: Agent[]; concessions: Concession[]; kind: "budget" | "travel"; gain: number } | null {
  let best: { agents: Agent[]; concessions: Concession[]; kind: "budget" | "travel"; gain: number } | null =
    null;
  for (const kind of ["budget", "travel"] as const) {
    const relaxed = relaxedBy(agents, kind);
    if (!relaxed) continue;
    const gain = survivorCount(relaxed.agents, day) - baseline;
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

function unanimous(survivors: Survivor[], positions: Position[][]): string | undefined {
  return survivors.find((s) =>
    positions.every((list) => list.find((p) => p.venueId === s.venueId)?.move === "accept"),
  )?.venueId;
}

function bestWorstCase(survivors: Survivor[], positions: Position[][]): string | undefined {
  const travel = new Map(survivors.map((s) => [s.venueId, s.longestTravelMin]));
  const ranked = survivors
    .map((s) => ({
      venueId: s.venueId,
      worst: Math.min(...positions.map((l) => l.find((p) => p.venueId === s.venueId)?.score ?? 0)),
    }))
    .sort(
      (a, b) =>
        b.worst - a.worst || (travel.get(a.venueId) ?? 0) - (travel.get(b.venueId) ?? 0),
    );
  return ranked[0]?.venueId;
}

/**
 * Contract 12, layers 1-3: personas hold positions across rounds, the binding
 * constraint is named without attribution, and each agent decides its own
 * movement. Synchronous -- layer 4 (asking a human mid-round) is not built.
 */
export async function negotiate(
  store: Store,
  planId: string,
  people: Participant[],
  day: Date = new Date(),
): Promise<NegotiationResult> {
  let agents: Agent[] = await Promise.all(
    people.map(async (participant) => {
      const user = await store.getUser(participant.userId);
      return {
        userId: participant.userId,
        participant,
        tastes: user?.profile.tastes ?? [],
        preferredSpots: user?.profile.preferredSpots ?? [],
        sensitive: participant.slots.sensitive ?? [],
      };
    }),
  );

  const rounds: RoundLog[] = [];
  let lastObjection: Objection | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const merged = mergeConstraints(agents.map((a) => a.participant), day);
    if (!hasOverlap(merged.window)) {
      return { status: "failed", reason: "no-overlap", binding: null, rounds };
    }

    const filtered = filterVenues(
      VENUES,
      merged,
      travelProfiles(agents.map((a) => a.participant)),
    );
    const ranked = rankedObjections(filtered.rejected, merged);
    const objection = ranked[0] ?? null;
    lastObjection = objection;

    const positions =
      filtered.survivors.length > 0 ? await positionsFor(agents, filtered.survivors) : [];
    const settledOn =
      filtered.survivors.length > 0 ? unanimous(filtered.survivors, positions) : undefined;

    if (settledOn) {
      rounds.push(
        toRoundLog(
          planId, round, filtered.survivors, filtered.rejected, positions, [], [],
          narrate(round, filtered.survivors.length, settledOn, objection, []),
          settledOn,
        ),
      );
      return { status: "settled", venueId: settledOn, rounds };
    }

    // Nobody agreed. Find the relaxation that would actually admit more venues,
    // from someone who did not hedge about that constraint.
    const relaxation = bestRelaxation(agents, day, filtered.survivors.length);
    const concessions = relaxation?.concessions ?? [];
    const asked: Objection | null = relaxation
      ? relaxation.kind === "budget"
        ? { kind: "budget", cap: merged.budgetCapUSD }
        : { kind: "travel", maxMin: 0 }
      : objection;
    if (relaxation) agents = relaxation.agents;

    rounds.push(
      toRoundLog(
        planId, round, filtered.survivors, filtered.rejected, positions,
        shuffle(objection ? [objection] : []), concessions,
        narrate(round, filtered.survivors.length, undefined, asked ?? objection, concessions),
      ),
    );

    // Nobody willing or able to move, and no agreement: further rounds are identical.
    if (concessions.length === 0) {
      if (filtered.survivors.length > 0) {
        const fallback = bestWorstCase(filtered.survivors, positions);
        if (fallback) return { status: "settled", venueId: fallback, rounds };
      }
      return { status: "failed", reason: "deadlock", binding: objection, rounds };
    }
  }

  // Round cap. Fall back to the least-bad option rather than failing outright.
  const merged = mergeConstraints(agents.map((a) => a.participant), day);
  const filtered = filterVenues(VENUES, merged, travelProfiles(agents.map((a) => a.participant)));
  if (filtered.survivors.length > 0) {
    const positions = await positionsFor(agents, filtered.survivors);
    const fallback = bestWorstCase(filtered.survivors, positions);
    if (fallback) return { status: "settled", venueId: fallback, rounds };
  }
  return { status: "failed", reason: "round-cap", binding: lastObjection, rounds };
}
