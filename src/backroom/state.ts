import type { MergedConstraints } from "../contracts.ts";
import { mergeConstraints } from "../aggregator.ts";
import type { Store } from "../db.ts";
import { venueById } from "../venues.ts";
import { DEMO_SAID } from "./fixtures.ts";

export type BackroomState = {
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
    }[];
  }[];
  said: Record<string, string[]>;
  merged: MergedConstraints | null;
};

// Split out of the server so it can be exercised without binding a port.
export async function buildState(store: Store, planId: string): Promise<BackroomState> {
  const rounds = await store.listRounds(planId);
  const slots = await store.getAllSlots(planId);
  const hasReal = Object.keys(slots).length > 0;

  const said = hasReal
    ? Object.fromEntries(
        Object.entries(slots).map(([userId, s]) => [
          userId,
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
    rounds: rounds.map((round) => ({
      ...round,
      candidates: round.candidates.map((c) => ({
        ...c,
        name: venueById(c.venueId)?.name ?? c.venueId,
        neighborhood: venueById(c.venueId)?.neighborhood ?? "",
        estCostUSD: venueById(c.venueId)?.estCostUSD ?? null,
      })),
    })),
    said,
    merged,
  };
}
