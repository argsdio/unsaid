import type {
  DietaryTag,
  Occasion,
  MergedConstraints,
  Slots,
  TimeWindow,
  TravelProfile,
} from "./contracts.ts";
import { defaultWindow } from "./resolve/time.ts";

// Used when nobody has named a budget, so an unanswered slot never filters.
const PERMISSIVE_BUDGET = 500;

export type Participant = { userId: string; slots: Slots };

// Returns exactly the three keys of MergedConstraints. A `value: null` slot
// contributes nothing rather than rejecting everything -- that is what keeps an
// unresolved answer from emptying the survivor set downstream.
export function mergeConstraints(
  people: Participant[],
  day: Date = new Date(),
  occasion: Occasion = "dinner",
): MergedConstraints {
  const budgets = people
    .map((p) => p.slots.budgetCapUSD?.value)
    .filter((v): v is number => typeof v === "number");

  const dietary = new Set<DietaryTag>();
  for (const person of people) {
    for (const tag of person.slots.dietary?.value ?? []) dietary.add(tag);
  }

  const windows = people
    .map((p) => p.slots.window?.value)
    .filter((w): w is TimeWindow => w !== null && w !== undefined);

  return {
    budgetCapUSD: budgets.length ? Math.min(...budgets) : PERMISSIVE_BUDGET,
    requiredDietary: [...dietary],
    window: intersect(windows, day, occasion),
  };
}

// The honest intersection, which may come back empty. A branches on hasOverlap
// rather than being handed a fabricated window.
function intersect(windows: TimeWindow[], day: Date, occasion: Occasion): TimeWindow {
  if (!windows.length) return defaultWindow(day, occasion);
  const start = windows.map((w) => w.start).reduce((a, b) => (a > b ? a : b));
  const end = windows.map((w) => w.end).reduce((a, b) => (a < b ? a : b));
  return { start, end };
}

export function hasOverlap(window: TimeWindow): boolean {
  return window.start < window.end;
}

// Homes and caps stay on B's side of the boundary; only filterVenues sees these.
export function travelProfiles(people: Participant[]): TravelProfile[] {
  return people.map((p) => ({
    userId: p.userId,
    home: p.slots.home?.value ?? null,
    maxTravelMin: p.slots.maxTravelMin?.value ?? null,
  }));
}
