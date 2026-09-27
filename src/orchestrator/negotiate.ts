import type { PlanDoc } from "../contracts.ts";
import type { Participant } from "../aggregator.ts";
import type { Store } from "../db.ts";
import { negotiate } from "../negotiation.ts";
import { venueById } from "../venues.ts";
import { botLog, slotSnapshot } from "../log.ts";
import { nothingFits, pickTime, planCard } from "./messages.ts";

export type NegotiateOutcome =
  | { ok: true; text: string }
  | { ok: false; text: string };

// The rounds, objections and concessions live in src/negotiation.ts (contract
// 12). This file gathers participants, logs, and turns the outcome into a
// message -- it does not decide anything.
export async function runNegotiation(store: Store, plan: PlanDoc): Promise<NegotiateOutcome> {
  const people: Participant[] = [];
  for (const userId of plan.participants) {
    const slots = await store.getSlots(plan._id, userId);
    people.push({ userId, slots });
    botLog("go: stored slots for participant", { userId, ...slotSnapshot(slots) });
  }

  const result = await negotiate(store, plan._id, people);
  for (const round of result.rounds) await store.appendRound(round);
  botLog("go: negotiation", {
    status: result.status,
    rounds: result.rounds.length,
    transcript: result.rounds.map((r) => r.narration),
  });

  if (result.status === "failed") {
    if (result.reason === "no-overlap") {
      botLog("go: fail — no overlapping time window", result.merged.window);
      return { ok: false, text: nothingFits(["time"]) };
    }
    // `binding` is already the single largest constraint by counterfactual
    // measure, so this names one thing to flex instead of listing every category.
    const area =
      result.binding?.kind === "travel"
        ? "travel"
        : result.binding?.kind === "dietary"
          ? "dietary"
          : "budget";
    botLog("go: fail", { reason: result.reason, binding: result.binding });
    return { ok: false, text: nothingFits([area]) };
  }

  const venue = venueById(result.venueId);
  if (!venue) return { ok: false, text: nothingFits(["budget"]) };

  const card = {
    venueId: venue.id,
    time: pickTime(result.merged.window),
    estCostUSD: venue.estCostUSD,
  };

  botLog("go: picked venue", { name: venue.name, time: card.time, estCostUSD: card.estCostUSD });
  return { ok: true, text: planCard(venue, card) };
}
