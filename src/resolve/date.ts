import { normalise } from "./gazetteer.ts";

const DAYS: Array<[number, string[]]> = [
  [0, ["sunday", "sun"]],
  [1, ["monday", "mon"]],
  [2, ["tuesday", "tues", "tue"]],
  [3, ["wednesday", "weds", "wed"]],
  [4, ["thursday", "thurs", "thur", "thu"]],
  [5, ["friday", "fri"]],
  [6, ["saturday", "sat"]],
];

function atMidnight(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function plusDays(from: Date, days: number): Date {
  const out = atMidnight(from);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * "dinner friday?" -> that Friday. Without this every plan is silently today,
 * so "after 7" resolves to tonight and a Tuesday blackout is applied to the
 * wrong day.
 *
 * A bare weekday means the coming one, counting today. "next friday" said ON a
 * Friday means the following week -- otherwise it means the same coming day,
 * which is how people actually use it.
 */
export function resolveDate(text: string, today: Date = new Date()): Date | null {
  const t = normalise(text);
  if (!t) return null;

  if (/\b(tonight|today)\b/.test(t)) return atMidnight(today);
  // People type "tmrw" as often as they type the whole word.
  if (/\b(tomorrow|tmrw|tmr|tmw|2moro)\b/.test(t)) return plusDays(today, 1);

  const wantsNext = /\bnext\b/.test(t);

  if (/\b(this )?weekend\b/.test(t)) {
    const untilSaturday = (6 - today.getDay() + 7) % 7;
    return plusDays(today, untilSaturday === 0 && wantsNext ? 7 : untilSaturday);
  }

  for (const [weekday, words] of DAYS) {
    if (!words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) continue;
    const until = (weekday - today.getDay() + 7) % 7;
    return plusDays(today, until === 0 && wantsNext ? 7 : until);
  }

  return null;
}
