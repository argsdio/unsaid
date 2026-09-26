import type { DietaryTag, Slot } from "../contracts.ts";
import { normalise } from "./gazetteer.ts";

const SYNONYMS: Array<[DietaryTag, string[]]> = [
  ["vegan", ["vegan", "plant based", "no animal products"]],
  ["vegetarian", ["vegetarian", "veggie", "no meat", "dont eat meat", "meat free", "meatless"]],
  ["pescatarian", ["pescatarian", "pescetarian", "only fish", "fish only", "only eat fish"]],
  ["halal", ["halal"]],
  ["kosher", ["kosher"]],
  ["gluten-free", ["gluten free", "gluten-free", "no gluten", "gluten intolerant", "celiac", "coeliac"]],
  ["dairy-free", ["dairy free", "no dairy", "lactose intolerant", "lactose", "cant do dairy"]],
  ["nut-free", ["nut free", "no nuts", "nut allergy", "allergic to nuts", "peanut allergy", "peanut allergic", "nuts", "tree nut"]],
  ["no-pork", ["no pork", "dont eat pork", "pork free", "cant eat pork"]],
  ["no-shellfish", ["no shellfish", "shellfish allergy", "allergic to shellfish", "no shrimp"]],
];

// "I can eat everything" is an ANSWER, not a missing slot. Checked only after
// tag matching fails, so "can't eat anything with nuts" resolves to nut-free
// rather than being mistaken for "no restrictions".
const NONE_PHRASES = [
  "i can eat everything",
  "can eat everything",
  "eat everything",
  "eats everything",
  "i eat everything",
  "i eat anything",
  "eat anything",
  "anything",
  "everything",
  "no restrictions",
  "no dietary restrictions",
  "no restriction",
  "no dietary",
  "no allergies",
  "not picky",
  "im not picky",
  "no preference",
  "omnivore",
  "unrestricted",
  "none",
  "nope",
  "nothing",
  "all good",
  "im good",
  "na",
];

function splitFragments(text: string): string[] {
  return text
    .split(/,|;|\band\b|\bplus\b|&|\balso\b/)
    .map((f) => f.trim())
    .filter(Boolean);
}

export type DietaryResult = { slot: Slot<DietaryTag[]>; unresolved: string[] };

// Two properties that matter: no-restriction phrasings resolve to [], a real
// value rather than a gap; and anything uncanonicalisable lands in `unresolved`,
// which never reaches the hard filter.
export function resolveDietary(raw: string): DietaryResult {
  const text = normalise(raw);
  if (!text) return { slot: { raw, value: null, confidence: "low" }, unresolved: [] };

  const found = new Set<DietaryTag>();
  const fragments = splitFragments(text);
  const unresolved: string[] = [];

  for (const fragment of fragments) {
    let matched = false;
    for (const [tag, words] of SYNONYMS) {
      if (words.some((w) => fragment.includes(w))) {
        found.add(tag);
        matched = true;
      }
    }
    if (!matched) unresolved.push(fragment);
  }

  if (found.size > 0) {
    // Partial resolution: the canonical part filters, the rest stays soft.
    return { slot: { raw, value: [...found], confidence: "high" }, unresolved };
  }

  if (NONE_PHRASES.includes(text)) {
    return { slot: { raw, value: [], confidence: "high" }, unresolved: [] };
  }

  // A loose match only counts when the sentence is barely longer than the phrase
  // itself and carries no avoidance word. Without both guards "cant eat anything
  // with nuts" reads as "no restrictions", which is the worst error here.
  const avoids = /\b(cant|cannot|can not|allergic|allergy|avoid|without|except|but no)\b/.test(text);
  const looselyNone =
    !avoids &&
    fragments.length <= 2 &&
    NONE_PHRASES.some((p) => text.includes(p) && text.length <= p.length + 8);
  if (looselyNone) {
    return { slot: { raw, value: [], confidence: "high" }, unresolved: [] };
  }

  // Answered, but we could not canonicalise any of it: soft signal only.
  return { slot: { raw, value: null, confidence: "low" }, unresolved };
}
