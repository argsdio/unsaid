import type { Coords, Home, Slot } from "../contracts.ts";
import { ALIASES, BOROUGHS, PLACES, normalise } from "./gazetteer.ts";

export type Geocoder = (query: string) => Promise<Coords | null>;

const STREET_HINT = /\b\d{1,4}\b.*\b(st|street|ave|avenue|blvd|boulevard|rd|road|pl|place|broadway|park|lane|ln|dr|drive)\b/;

/** Longest alias/place key first, so "east village" wins over "village". */
const KEYS: string[] = [...Object.keys(PLACES), ...Object.keys(ALIASES)].sort(
  (a, b) => b.length - a.length,
);

function canonical(key: string): Coords | undefined {
  const direct = PLACES[key];
  if (direct) return direct;
  const aliased = ALIASES[key];
  return aliased ? PLACES[aliased] : undefined;
}

const ACRONYMS: Record<string, string> = { nyu: "NYU", dumbo: "DUMBO" };

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
  for (const key of KEYS) {
    if (text.includes(key)) {
      const hit = canonical(key);
      if (hit) return { raw, value: { ...hit, label: label(key) }, confidence: "high" };
    }
  }

  if (geocode && (STREET_HINT.test(text) || text.split(" ").length <= 6)) {
    try {
      const found = await geocode(raw);
      if (found) return { raw, value: { ...found, label: raw.trim() }, confidence: "high" };
    } catch {
      // Network trouble must never block slot-filling; fall through.
    }
  }

  for (const [name, centre] of Object.entries(BOROUGHS)) {
    if (text.includes(name)) {
      return { raw, value: { ...centre, label: label(name) }, confidence: "low" };
    }
  }

  return { raw, value: null, confidence: "low" };
}
