import type { Coords, Home, Slot } from "../contracts.ts";
import { ALIASES, BOROUGHS, PLACES, normalise } from "./gazetteer.ts";

export type Geocoder = (query: string) => Promise<Coords | null>;

const STREET_HINT = /\b\d{1,4}\b.*\b(st|street|ave|avenue|blvd|boulevard|rd|road|pl|place|broadway|park|lane|ln|dr|drive)\b/;

// Longest key first, so "east village" wins over "village". Matched on word
// boundaries, not as bare substrings: without \b the alias "ev" matches inside
// "everything" and "whatever", and "les" inside "unless" and "please", which
// silently resolves someone's home to a neighbourhood they never mentioned.
const KEYS: Array<[string, RegExp]> = [...Object.keys(PLACES), ...Object.keys(ALIASES)]
  .sort((a, b) => b.length - a.length)
  .map((key) => [key, new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)]);

function canonical(key: string): Coords | undefined {
  const direct = PLACES[key];
  if (direct) return direct;
  const aliased = ALIASES[key];
  return aliased ? PLACES[aliased] : undefined;
}

const ACRONYMS: Record<string, string> = { nyu: "NYU", dumbo: "DUMBO" };

// Filler around a place name, so a geocoded answer reads like a place.
const FILLER = /^(?:i'?m|im|i am|we'?re|currently|right|just)?\s*(?:at|in|on|near|around|by|close to|next to|coming from|starting from|from)\s+|\s*(?:actually|rn|right now|now|tho|though|please|thanks)\.?$/gi;

function tidyPlace(raw: string): string {
  const cleaned = raw.trim().replace(FILLER, "").replace(/\s+/g, " ").trim();
  const text = cleaned || raw.trim();
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

function label(key: string): string {
  const target = PLACES[key] ? key : (ALIASES[key] ?? key);
  return ACRONYMS[target] ?? target.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Neighbourhoods are deliberately not a category: the filter needs travel time,
// which needs a point, so WTC, Bushwick and a street address all resolve to the
// same shape. The geocoder is optional so the harness runs offline.
export async function resolveHome(raw: string, geocode?: Geocoder): Promise<Slot<Home>> {
  const text = normalise(raw);
  if (!text) return { raw, value: null, confidence: "low" };

  const exact = canonical(text);
  if (exact) return { raw, value: { ...exact, label: label(text) }, confidence: "high" };

  // "i'm near union square", "close to WTC", "right by bushwick"
  for (const [key, pattern] of KEYS) {
    if (pattern.test(text)) {
      const hit = canonical(key);
      if (hit) return { raw, value: { ...hit, label: label(key) }, confidence: "high" };
    }
  }

  if (geocode && (STREET_HINT.test(text) || text.split(" ").length <= 6)) {
    try {
      const found = await geocode(raw);
      // The label is shown back to people ("Transit from ..."), so it cannot be
      // the whole sentence they typed: "im at 60th and lex actually" reads badly.
      if (found) return { raw, value: { ...found, label: tidyPlace(raw) }, confidence: "high" };
    } catch {
      // Network trouble must never block slot-filling; fall through.
    }
  }

  for (const [name, centre] of Object.entries(BOROUGHS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      return { raw, value: { ...centre, label: label(name) }, confidence: "low" };
    }
  }

  return { raw, value: null, confidence: "low" };
}
