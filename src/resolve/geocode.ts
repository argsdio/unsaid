import type { Coords } from "../contracts.ts";
import { GROK_MODEL, grok } from "../grok.ts";
import type { Geocoder } from "./location.ts";

const cache = new Map<string, Coords | null>();

// The rung of resolveHome's ladder that was never connected. Handles what a
// hand-built gazetteer cannot: cross-streets ("60th and Lex"), street addresses,
// and places outside the list ("jersey city", "near campus").
//
// Returns undefined when no key is configured, so callers degrade to the
// gazetteer rather than breaking.
export function grokGeocoder(): Geocoder | undefined {
  const client = grok();
  if (!client) return undefined;

  return async (query: string): Promise<Coords | null> => {
    const key = query.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    try {
      const response = await client.chat.completions.create({
        model: GROK_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Return the coordinates of a location in or near New York City as " +
              '{"lat":number,"lng":number}. Handle cross-streets ("60th and Lex"), ' +
              'addresses, landmarks and neighborhoods. If it is not a place, return {}.',
          },
          { role: "user", content: query },
        ],
      });
      const content = response.choices[0]?.message.content;
      const parsed = content ? (JSON.parse(content) as { lat?: unknown; lng?: unknown }) : {};
      const lat = typeof parsed.lat === "number" ? parsed.lat : null;
      const lng = typeof parsed.lng === "number" ? parsed.lng : null;

      // Anything outside the NYC metro box is a hallucination, not an answer.
      const inRange = lat !== null && lng !== null && lat > 40.3 && lat < 41.1 && lng > -74.4 && lng < -73.5;
      const result = inRange ? { lat, lng } : null;
      cache.set(key, result);
      return result;
    } catch (error) {
      console.warn(`[geocode] ${GROK_MODEL} failed for ${JSON.stringify(query)}: ${(error as Error).message}`);
      cache.set(key, null);
      return null;
    }
  };
}
