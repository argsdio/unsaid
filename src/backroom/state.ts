import type { MergedConstraints } from "../contracts.ts";
import { mergeConstraints } from "../aggregator.ts";
import type { Store } from "../db.ts";
import { shortName } from "../status.ts";
import { priceTier, venueById } from "../venues.ts";
import { DEMO_PLAN_ID, DEMO_SAID } from "./fixtures.ts";

export type BackroomState = {
  planId: string;
  demo: boolean;
  rounds: {
    planId: string;
    round: number;
    at: string;
    narration?: string;
    settledOn?: string;
    candidates: {
      venueId: string;
      passed: boolean;
      failedOn?: string;
      scores: number[];
      name: string;
      neighborhood: string;
      estCostUSD: number | null;
      cuisine?: string;
      price?: string;
    }[];
  }[];
  said: Record<string, string[]>;
  merged: MergedConstraints | null;
};

// The reveal is projected, so a whole number must never leave the API. Two
// people can also share their last four, and an object key collision would
// drop one of them off the screen entirely.
function uniqueLabels(userIds: string[]): Map<string, string> {
  const taken = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const userId of userIds) {
    const base = shortName(userId);
    const seen = taken.get(base) ?? 0;
    taken.set(base, seen + 1);
    labels.set(userId, seen === 0 ? base : `${base} (${seen + 1})`);
  }
  return labels;
}

// Split out of the server so it can be exercised without binding a port.
export async function buildState(store: Store, planId: string): Promise<BackroomState> {
  const rounds = await store.listRounds(planId);
  const slots = await store.getAllSlots(planId);
  const hasReal = Object.keys(slots).length > 0;

  const labels = uniqueLabels(Object.keys(slots));
  const said = hasReal
    ? Object.fromEntries(
        Object.entries(slots).map(([userId, s]) => [
          labels.get(userId) ?? userId,
          [s.home?.raw, s.budgetCapUSD?.raw, s.dietary?.raw, s.window?.raw, s.maxTravelMin?.raw].filter(
            (v): v is string => Boolean(v),
          ),
        ]),
      )
    : DEMO_SAID;

  const merged = hasReal
    ? mergeConstraints(Object.entries(slots).map(([userId, s]) => ({ userId, slots: s })))
    : null;

  return {
    planId,
    demo: planId === DEMO_PLAN_ID,
    rounds: rounds.map((round) => ({
      ...round,
      candidates: round.candidates.map((c) => ({
        ...c,
        name: venueById(c.venueId)?.name ?? c.venueId,
        neighborhood: venueById(c.venueId)?.neighborhood ?? "",
        estCostUSD: venueById(c.venueId)?.estCostUSD ?? null,
        ...(venueById(c.venueId)
          ? { cuisine: venueById(c.venueId)!.cuisine, price: priceTier(venueById(c.venueId)!) }
          : {}),
      })),
    })),
    said,
    merged,
  };
}
