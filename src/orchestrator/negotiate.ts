import type { Evaluation, RoundLog, Survivor } from "../contracts.ts";
import { type Participant, hasOverlap, mergeConstraints, travelProfiles } from "../aggregator.ts";
import { scoreCandidates } from "../agent/score.ts";
import type { PlanDoc } from "../contracts.ts";
import type { Store } from "../db.ts";
import { VENUES, filterVenues, venueById } from "../venues.ts";
import { botLog, slotSnapshot } from "../log.ts";
import { nothingFits, pickTime, planCard } from "./messages.ts";
import { selectBestWorst } from "./select.ts";

export type NegotiateOutcome =
  | { ok: true; text: string }
  | { ok: false; text: string };

export async function runNegotiation(store: Store, plan: PlanDoc): Promise<NegotiateOutcome> {
  const people: Participant[] = [];
  for (const userId of plan.participants) {
    const slots = await store.getSlots(plan._id, userId);
    people.push({ userId, slots });
    botLog("go: stored slots for participant", { userId, ...slotSnapshot(slots) });
  }

  const merged = mergeConstraints(people);
  botLog("go: merged hard limits (what the filter sees)", merged);
  if (!hasOverlap(merged.window)) {
    botLog("go: fail — no overlapping time window", merged.window);
    return { ok: false, text: nothingFits(["time"]) };
  }

  const filtered = filterVenues(VENUES, merged, travelProfiles(people));
  const rejectionCounts: Record<string, number> = {};
  for (const r of filtered.rejected) {
    rejectionCounts[r.failedOn] = (rejectionCounts[r.failedOn] ?? 0) + 1;
  }
  botLog("go: filter result", {
    survivors: filtered.survivors.length,
    of: VENUES.length,
    rejectionCounts,
    mergedBudget: merged.budgetCapUSD,
    mergedDiet: merged.requiredDietary,
  });
  if (filtered.survivors.length === 0) {
    const areas = [...new Set(filtered.rejected.map((r) => r.failedOn))];
    botLog("go: fail — zero venues survived hard filters", { areas, rejectionCounts });
    return { ok: false, text: nothingFits(areas) };
  }

  const perPerson: Evaluation[][] = [];
  for (const person of people) {
    const user = await store.getUser(person.userId);
    perPerson.push(
      await scoreCandidates(filtered.survivors, {
        slots: person.slots,
        tastes: user?.profile.tastes ?? [],
        preferredSpots: user?.profile.preferredSpots ?? [],
      }),
    );
  }

  const chosen = selectBestWorst(filtered.survivors, perPerson);
  const scoresByVenue = (venueId: string) =>
    perPerson.map((list) => list.find((e) => e.venueId === venueId)?.score ?? 0);

  const round: RoundLog = {
    planId: plan._id,
    round: 1,
    at: new Date().toISOString(),
    candidates: [
      ...filtered.survivors.map((s: Survivor) => {
        const evals = perPerson.map(
          (list) => list.find((e) => e.venueId === s.venueId) ?? { venueId: s.venueId, pass: false, score: 0 },
        );
        return {
          venueId: s.venueId,
          passed: evals.every((e) => e.pass),
          scores: scoresByVenue(s.venueId),
        };
      }),
      ...filtered.rejected.map((r) => ({
        venueId: r.venueId,
        passed: false,
        failedOn: r.failedOn,
        scores: [] as number[],
      })),
    ],
  };
  await store.appendRound(round);

  if (!chosen) {
    botLog("go: fail — survivors existed but none passed scoring for everyone");
    return {
      ok: false,
      text: "Some places passed the hard cuts, but none worked for everyone. Flex on budget, diet, or travel, then the host can send go again.",
    };
  }

  const venue = venueById(chosen.venueId);
  if (!venue) {
    return { ok: false, text: nothingFits(["budget", "dietary", "travel"]) };
  }

  const card = {
    venueId: venue.id,
    time: pickTime(merged.window),
    estCostUSD: venue.estCostUSD,
  };

  botLog("go: picked venue", { name: venue.name, time: card.time, estCostUSD: card.estCostUSD });
  return { ok: true, text: planCard(venue, card) };
}
