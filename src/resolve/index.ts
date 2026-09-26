import type { Slots } from "../contracts.ts";
import { resolveDietary } from "./dietary.ts";
import { resolveTravelMin } from "./duration.ts";
import { type Geocoder, resolveHome } from "./location.ts";
import { resolveBudget } from "./money.ts";
import { resolveWindow } from "./time.ts";

export { resolveDietary, resolveTravelMin, resolveHome, resolveBudget, resolveWindow };
export type { Geocoder };

// What extraction emits: verbatim words, never canonical values.
export type RawSlots = {
  budgetRaw?: string;
  dietaryRaw?: string;
  windowRaw?: string;
  homeRaw?: string;
  travelRaw?: string;
  tags?: string[];
  namedSpots?: string[];
};

function dedupe(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!existing && !incoming) return undefined;
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])];
}

// A new answer never clears a resolved one, so a garbled follow-up cannot undo a
// good earlier answer.
export async function resolveSlots(
  raw: RawSlots,
  existing: Slots = {},
  geocode?: Geocoder,
  day: Date = new Date(),
): Promise<Slots> {
  const next: Slots = { ...existing };

  if (raw.budgetRaw?.trim()) {
    const slot = resolveBudget(raw.budgetRaw);
    if (slot.value !== null || next.budgetCapUSD === undefined) next.budgetCapUSD = slot;
  }

  if (raw.dietaryRaw?.trim()) {
    const { slot, unresolved } = resolveDietary(raw.dietaryRaw);
    if (slot.value !== null || next.dietary === undefined) next.dietary = slot;
    if (unresolved.length) next.unresolved = dedupe(next.unresolved, unresolved);
  }

  if (raw.windowRaw?.trim()) {
    const slot = resolveWindow(raw.windowRaw, day);
    if (slot.value !== null || next.window === undefined) next.window = slot;
  }

  if (raw.homeRaw?.trim()) {
    const slot = await resolveHome(raw.homeRaw, geocode);
    if (slot.value !== null || next.home === undefined) next.home = slot;
  }

  if (raw.travelRaw?.trim()) {
    const slot = resolveTravelMin(raw.travelRaw);
    if (slot.value !== null || next.maxTravelMin === undefined) next.maxTravelMin = slot;
  }

  const tags = dedupe(next.tags, raw.tags);
  if (tags) next.tags = tags;
  const namedSpots = dedupe(next.namedSpots, raw.namedSpots);
  if (namedSpots) next.namedSpots = namedSpots;

  return next;
}
