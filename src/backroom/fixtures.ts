import type { RoundLog } from "../contracts.ts";

export const DEMO_PLAN_ID = "demo";

// Hand-written rounds matching contract 7, so the screen can be built and
// rehearsed before A's orchestrator writes a single row.
export const DEMO_ROUNDS: RoundLog[] = [
  {
    planId: DEMO_PLAN_ID,
    round: 1,
    at: new Date().toISOString(),
    candidates: [
      { venueId: "cote", passed: false, failedOn: "budget", scores: [] },
      { venueId: "lilia", passed: false, failedOn: "budget", scores: [] },
      { venueId: "mighty-quinns", passed: false, failedOn: "dietary", scores: [] },
      { venueId: "bunna-cafe", passed: false, failedOn: "travel", scores: [] },
      { venueId: "joes-pizza", passed: true, scores: [0.37, 0.87, 0.13] },
      { venueId: "samesa", passed: true, scores: [0.43, 0.19, 0.81] },
      { venueId: "paulie-gees-slice", passed: true, scores: [0.29, 0.92, 0.29] },
    ],
  },
];

export const DEMO_SAID: Record<string, string[]> = {
  maya: ["im in bushwick", "$25 tops, kinda broke rn", "vegetarian", "after 7"],
  dev: ["im right by WTC", "anywhere from 20-45 is fine", "I can eat everything", "free 6 to 11"],
  priya: ["near washington square", "like 30", "not picky", "after 8", "30 min"],
};
