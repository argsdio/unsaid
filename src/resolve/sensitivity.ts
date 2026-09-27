import type { RequiredSlot } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";

// Hedging, apology and self-deprecation. "$25" and "$25 tops, kinda broke rn"
// resolve to the same number but are not the same utterance, and the difference
// decides who the negotiation is allowed to push.
const MARKERS = [
  "kinda",
  "kind of",
  "sorry",
  "broke",
  "tight",
  "tbh",
  "honestly",
  "if thats ok",
  "if that works",
  "is that ok",
  "hopefully",
  "unfortunately",
  "i know its",
  "i cant really",
  "cant really",
  "cheap side",
  "on a budget",
  "student",
  "low key",
  "no more than",
  "at most",
  "tops",
  "max",
  "hard limit",
  "really cant",
  "struggling",
  "dont have much",
  "not much to spend",
];

// A slot the person hedged about. Never asked to flex, no matter how much it
// would help the group -- that restraint is the product.
export function isSensitive(raw: string | undefined): boolean {
  if (!raw) return false;
  const text = normalise(raw);
  return MARKERS.some((marker) => text.includes(marker));
}

export function sensitiveSlots(
  entries: Array<[RequiredSlot, string | undefined]>,
): RequiredSlot[] {
  return entries.filter(([, raw]) => isSensitive(raw)).map(([slot]) => slot);
}
