import type { MergedConstraints, RoundLog, TravelProfile } from "../contracts.ts";
import { VENUES, filterVenues } from "../venues.ts";

export const DEMO_PLAN_ID = "demo";

// Derived from the real catalogue and the real filter rather than hand-picked, so
// the default view has the shape a live round actually has: a handful of
// survivors against roughly forty eliminations.
const DEMO_MERGED: MergedConstraints = {
  budgetCapUSD: 25,
  requiredDietary: ["vegetarian"],
  window: { start: "2026-09-26T20:00:00", end: "2026-09-26T23:00:00" },
};

const DEMO_PEOPLE: TravelProfile[] = [
  { userId: "maya", home: { lat: 40.6944, lng: -73.9213, label: "Bushwick" }, maxTravelMin: 60 },
  { userId: "dev", home: { lat: 40.7127, lng: -74.0134, label: "World Trade Center" }, maxTravelMin: 60 },
  { userId: "priya", home: { lat: 40.7295, lng: -73.9965, label: "NYU" }, maxTravelMin: 30 },
];

// Stable pseudo-scores so the screen looks the same on every reload.
function fakeScores(venueId: string): number[] {
  const seed = [...venueId].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return [0, 1, 2].map((i) => Number((0.15 + ((seed * (i + 3)) % 70) / 100).toFixed(2)));
}

function demoRound(): RoundLog {
  const { survivors, rejected } = filterVenues(VENUES, DEMO_MERGED, DEMO_PEOPLE);
  return {
    planId: DEMO_PLAN_ID,
    round: 1,
    at: new Date().toISOString(),
    candidates: [
      ...survivors.map((s) => ({
        venueId: s.venueId,
        passed: true,
        scores: fakeScores(s.venueId),
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

export const DEMO_ROUNDS: RoundLog[] = [demoRound()];

export const DEMO_SAID: Record<string, string[]> = {
  maya: ["im in bushwick", "$25 tops, kinda broke rn", "vegetarian", "after 7"],
  dev: ["im right by WTC", "anywhere from 20-45 is fine", "I can eat everything", "free 6 to 11"],
  priya: ["near washington square", "like 30", "not picky", "after 8", "30 min"],
};
