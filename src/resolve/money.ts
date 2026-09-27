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

  const range = text.match(/(\d+)\s*(?:-|to|through)\s*(\d+)/);
  if (range?.[2]) return { raw, value: Number(range[2]), confidence: "high" };

  if (OPEN_PHRASES.some((p) => text.includes(p))) {
    return { raw, value: 500, confidence: "high" };
  }

  const single = text.match(/(\d+)/);
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
