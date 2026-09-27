import type { Blackout } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";
import { resolveWindow } from "./time.ts";

const DAY_WORDS: Array<[number[], string[]]> = [
  [[1, 2, 3, 4, 5], ["weekdays", "weeknights", "weekday", "weeknight", "during the week"]],
  [[0, 6], ["weekends", "weekend"]],
  [[0], ["sundays", "sunday", "sun"]],
  [[1], ["mondays", "monday", "mon"]],
  [[2], ["tuesdays", "tuesday", "tues", "tue"]],
  [[3], ["wednesdays", "wednesday", "weds", "wed"]],
  [[4], ["thursdays", "thursday", "thurs", "thu"]],
  [[5], ["fridays", "friday", "fri"]],
  [[6], ["saturdays", "saturday", "sat"]],
];

// Whole evening, when someone names a day but no hours.
const DEFAULT_START = "18:00";
const DEFAULT_END = "23:59";

function hhmm(iso: string): string {
  return iso.slice(11, 16);
}

// "I have class tuesday nights" -> every Tuesday 18:00-23:59.
// Returns null when no day is named, since a blackout without a day is not a
// standing constraint -- it belongs in the per-plan window instead.
export function resolveBlackout(raw: string): Blackout | null {
  const text = normalise(raw);
  if (!text) return null;

  const days = new Set<number>();
  for (const [nums, words] of DAY_WORDS) {
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(text))) {
      for (const n of nums) days.add(n);
    }
  }
  if (days.size === 0) return null;

  const window = resolveWindow(text);
  const start = window.value ? hhmm(window.value.start) : DEFAULT_START;
  const end = window.value ? hhmm(window.value.end) : DEFAULT_END;

  return { days: [...days].sort(), start, end };
}

export function resolveBlackouts(raw: string): Blackout[] {
  return raw
    .split(/,|;|\band\b|\balso\b/)
    .map((fragment) => resolveBlackout(fragment))
    .filter((b): b is Blackout => b !== null);
}
