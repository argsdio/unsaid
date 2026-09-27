import type { Slot } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";

const OPEN_PHRASES = [
  "no limit",
  "no budget",
  "no budget preference",
  "no preference",
  "doesnt matter",
  "dont care",
  "whatever",
  "flexible",
  "unlimited",
  "i have no budget",
];

const WORDS: Array<[number, string[]]> = [
  [15, ["broke", "super cheap", "really cheap", "as cheap as possible", "dirt cheap", "tight"]],
  [20, ["cheap", "cheapish", "not much", "low key", "student budget"]],
  [35, ["moderate", "mid", "middle", "not too expensive", "nothing crazy", "reasonable", "normal"]],
  [60, ["nice", "treat", "splurge", "fancy"]],
];

/** Free text -> a dollar cap. A range resolves to its upper bound, since it is a cap. */
export function resolveBudget(raw: string): Slot<number> {
  const text = normalise(raw);
  if (!text) return { raw, value: null, confidence: "low" };

  // An explicit currency marker beats everything: in "after 7, an hour away, $30"
  // the budget is 30, not 7.
  const marked = text.match(/\$\s*(\d+)/) ?? text.match(/(\d+)\s*(?:dollars|bucks|usd)\b/);
  if (marked?.[1]) {
    const n = Number(marked[1]);
    if (n >= 1 && n <= 5000) return { raw, value: n, confidence: "high" };
  }

  // Otherwise strip times of day and durations before looking for a bare number,
  // so "after 7" is not read as $7 and "30 min away" is not read as $30.
  // Order matters. The two-number clock must be stripped BEFORE the prefix-word
  // rule: normalise() turns "7:30" into "7 30", and stripping "around 7" first
  // leaves a bare 30 that then reads as a budget.
  const cleaned = text
    .replace(/\b\d{1,2}\s*[:\s]\s*\d{2}\s*(?:am|pm)?\b/g, " ")
    .replace(/\b\d{1,2}\s*ish\b/g, " ")
    .replace(/\b(?:after|before|at|by|from|until|till|til|around|past)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/g, " ")
    .replace(/\b\d{1,2}\s*(?:am|pm)\b/g, " ")
    .replace(/\b\d+\s*(?:min|mins|minute|minutes|hr|hrs|hour|hours)\b/g, " ");

  const range = cleaned.match(/(\d+)\s*(?:-|to|through)\s*(\d+)/);
  if (range?.[2]) return { raw, value: Number(range[2]), confidence: "high" };

  if (OPEN_PHRASES.some((p) => text.includes(p))) {
    return { raw, value: 500, confidence: "high" };
  }

  const single = cleaned.match(/(\d+)/);
  if (single?.[1]) {
    const n = Number(single[1]);
    if (n >= 8 && n <= 500) return { raw, value: n, confidence: "high" };
  }

  for (const [amount, words] of WORDS) {
    if (words.some((w) => text.includes(w))) {
      return { raw, value: amount, confidence: "low" };
    }
  }

  return { raw, value: null, confidence: "low" };
}
