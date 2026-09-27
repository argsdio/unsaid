import { readFileSync } from "node:fs";
import type {
  FilterResult,
  MergedConstraints,
  Rejection,
  Survivor,
  TravelProfile,
  Venue,
} from "./contracts.ts";
import { travelMin } from "./travel.ts";

export const VENUES: Venue[] = JSON.parse(
  readFileSync(new URL("./venues.json", import.meta.url), "utf8"),
) as Venue[];

const BY_ID = new Map(VENUES.map((v) => [v.id, v]));

export function venueById(id: string): Venue | undefined {
  return BY_ID.get(id);
}

// B owns this; A calls it. Check order decides which category a rejection is
// attributed to, so budget before dietary before travel.
export function filterVenues(
  venues: Venue[],
  merged: MergedConstraints,
  people: TravelProfile[],
): FilterResult {
  const survivors: Survivor[] = [];
  const rejected: Rejection[] = [];

  for (const venue of venues) {
    if (venue.estCostUSD > merged.budgetCapUSD) {
      rejected.push({ venueId: venue.id, failedOn: "budget" });
      continue;
    }

    if (!merged.requiredDietary.every((tag) => venue.tags.includes(tag))) {
      rejected.push({ venueId: venue.id, failedOn: "dietary" });
      continue;
    }

    let longest = 0;
    let tooFar = false;
    for (const person of people) {
      if (!person.home) continue;
      const minutes = travelMin(person.home, venue);
      if (person.maxTravelMin !== null && minutes > person.maxTravelMin) {
        tooFar = true;
        break;
      }
      longest = Math.max(longest, minutes);
    }
    if (tooFar) {
      rejected.push({ venueId: venue.id, failedOn: "travel" });
      continue;
    }

    survivors.push({ venueId: venue.id, longestTravelMin: longest });
  }

  return { survivors, rejected };
}

// Loose name match so "I love Joe's Pizza" during onboarding becomes a real
// venue id rather than a free-text taste word.
export function findVenueByName(text: string): Venue | undefined {
  const needle = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (needle.length < 3) return undefined;
  return VENUES.find((v) => {
    const name = v.name.toLowerCase().replace(/[^a-z0-9 ]/g, "");
    return needle.includes(name) || name.includes(needle);
  });
}
