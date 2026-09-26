import type { Evaluation, Slots, Survivor, Venue } from "../contracts.ts";
import { GROK_MODEL, grok } from "../grok.ts";
import { venueById } from "../venues.ts";

export type ScoreContext = {
  slots: Slots;
  tastes: string[];
  preferredSpots: string[];
};

// Below this a candidate is a soft veto, which is what the flex whisper asks
// about. Hard constraints were already applied by filterVenues.
const PASS_FLOOR = 0.15;
const WHISPER_FLOOR = 0.25;

// Graded on purpose. Binary 1/0 scores tie at zero under best-worst-case
// selection and make A's picker arbitrary.
export function scoreLocal(venue: Venue, longestTravelMin: number, ctx: ScoreContext): Evaluation {
  let score = 0.3;

  const liked = new Set([...ctx.preferredSpots, ...(ctx.slots.namedSpots ?? [])]);
  if (liked.has(venue.id)) score += 0.5;

  const wanted = new Set([...ctx.tastes, ...(ctx.slots.tags ?? [])].map((t) => t.toLowerCase()));
  const overlap = venue.tags.filter((t) => wanted.has(t.toLowerCase())).length;
  score += Math.min(0.3, overlap * 0.12);

  // Soft signal only: unresolved phrases are scored, never filtered on.
  const soft = (ctx.slots.unresolved ?? []).join(" ").toLowerCase();
  if (soft && venue.tags.some((t) => soft.includes(t.toLowerCase()))) score += 0.05;

  score -= Math.min(0.25, (longestTravelMin / 60) * 0.25);

  // Floor above zero so near-misses stay distinguishable.
  score = Math.max(0.02, Math.min(1, Number(score.toFixed(3))));

  const pass = score >= PASS_FLOOR;
  return {
    venueId: venue.id,
    pass,
    score,
    ...(score < WHISPER_FLOOR ? { needsMyHuman: true as const } : {}),
  };
}

// One call per person, never per venue, and it only ever sees its own person's
// profile -- that separation is the privacy claim.
export async function scoreCandidates(
  survivors: Survivor[],
  ctx: ScoreContext,
): Promise<Evaluation[]> {
  const pairs = survivors.flatMap((s) => {
    const venue = venueById(s.venueId);
    return venue ? [{ venue, survivor: s }] : [];
  });
  const local = pairs.map(({ venue, survivor }) =>
    scoreLocal(venue, survivor.longestTravelMin, ctx),
  );

  const client = grok();
  if (!client) return local;

  try {
    const response = await client.chat.completions.create({
      model: GROK_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You score restaurant options for ONE person against their tastes. " +
            "Return JSON {\"scores\":[{\"venueId\":string,\"score\":number}]} with score 0-1. " +
            "Spread the scores; do not return only 0 and 1. Never explain your reasoning.",
        },
        {
          role: "user",
          content: JSON.stringify({
            tastes: [...ctx.tastes, ...(ctx.slots.tags ?? [])],
            preferredSpots: ctx.preferredSpots,
            notes: ctx.slots.unresolved ?? [],
            candidates: pairs.map(({ venue, survivor }) => ({
              venueId: venue.id,
              name: venue.name,
              tags: venue.tags,
              estCostUSD: venue.estCostUSD,
              travelMin: survivor.longestTravelMin,
            })),
          }),
        },
      ],
    });

    const raw = response.choices[0]?.message.content;
    if (!raw) return local;
    const parsed = JSON.parse(raw) as { scores?: { venueId: string; score: number }[] };
    const byId = new Map((parsed.scores ?? []).map((s) => [s.venueId, s.score]));

    return local.map((evaluation) => {
      const llm = byId.get(evaluation.venueId);
      if (typeof llm !== "number" || Number.isNaN(llm)) return evaluation;
      // Blend rather than replace: the deterministic part keeps travel and
      // explicit saved spots honest if the model is erratic.
      const score = Math.max(0.02, Math.min(1, Number((evaluation.score * 0.5 + llm * 0.5).toFixed(3))));
      return {
        venueId: evaluation.venueId,
        pass: score >= PASS_FLOOR,
        score,
        ...(score < WHISPER_FLOOR ? { needsMyHuman: true as const } : {}),
      };
    });
  } catch {
    return local;
  }
}
