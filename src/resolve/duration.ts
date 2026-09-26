import type { Slot } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";

const WORDS: Array<[number, string[]]> = [
  [15, ["walking distance", "walk there", "very close", "super close", "right here"]],
  [20, ["not far", "close by", "nearby", "close", "short trip", "stay local", "my neighborhood"]],
  [30, ["half an hour", "half hour", "30ish", "reasonable"]],
  [60, ["an hour", "one hour", "dont mind", "do not mind", "anywhere", "i can travel", "happy to travel", "whatever"]],
];

export function resolveTravelMin(raw: string): Slot<number> {
  const text = normalise(raw);
  if (!text) return { raw, value: null, confidence: "low" };

  const explicit = text.match(/(\d+)\s*(?:min|minute|mins|minutes)/);
  if (explicit?.[1]) return { raw, value: Number(explicit[1]), confidence: "high" };

  const hours = text.match(/(\d+)\s*(?:hr|hour|hours)/);
  if (hours?.[1]) return { raw, value: Number(hours[1]) * 60, confidence: "high" };

  for (const [minutes, words] of WORDS) {
    if (words.some((w) => text.includes(w))) {
      return { raw, value: minutes, confidence: "low" };
    }
  }

  const bare = text.match(/^(\d+)$/);
  if (bare?.[1]) return { raw, value: Number(bare[1]), confidence: "low" };

  return { raw, value: null, confidence: "low" };
}
