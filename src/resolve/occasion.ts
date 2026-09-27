import type { Occasion } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";

// Longest first, so "late lunch" is not read as "lunch" by a shorter rule and
// "brunch" is never swallowed by "lunch" as a substring.
const WORDS: Array<[Occasion, string[]]> = [
  ["brunch", ["brunch", "breakfast", "bfast", "morning"]],
  // Boba is a coffee-shaped outing: an afternoon, a drink, somewhere cheap.
  ["coffee", ["coffee", "cafe", "espresso", "tea", "boba", "bubble tea", "matcha", "dessert", "ice cream", "hang out", "study"]],
  ["drinks", ["drinks", "drink", "cocktails", "bar", "happy hour", "nightcap", "beers"]],
  ["lunch", ["lunch", "midday", "noon"]],
  ["dinner", ["dinner", "supper", "eat", "food", "tonight"]],
];

// Dinner is the default because it is what the app has always assumed, and
// because "are we doing something friday?" with no other signal usually is.
export function resolveOccasion(text: string, fallback: Occasion = "dinner"): Occasion {
  const t = normalise(text);
  if (!t) return fallback;
  for (const [occasion, words] of WORDS) {
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return occasion;
  }
  return fallback;
}

// When an occasion typically happens, and how a bare hour should be read.
// Somebody answering "11" about brunch means 11am; about drinks they mean 11pm.
export const WINDOWS: Record<Occasion, { start: number; end: number; amHours: number[] }> = {
  brunch: { start: 10 * 60, end: 14 * 60, amHours: [7, 8, 9, 10, 11] },
  coffee: { start: 8 * 60, end: 17 * 60, amHours: [7, 8, 9, 10, 11] },
  lunch: { start: 11 * 60 + 30, end: 15 * 60, amHours: [10, 11] },
  dinner: { start: 17 * 60, end: 23 * 60 + 59, amHours: [] },
  drinks: { start: 19 * 60, end: 23 * 60 + 59, amHours: [] },
};

export function label(occasion: Occasion): string {
  return occasion;
}
