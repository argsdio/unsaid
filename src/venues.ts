import { readFileSync } from "node:fs";
import type {
  FilterResult,
  Occasion,
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

// Inferred from the hand-written tags, because editing fifty entries by hand to
// add one field is a worse use of the time than a documented guess. A catalogue
// built from Google Places would set `meals` from real `types` and this would
// only be the fallback.
const MEAL_TAGS: Array<[Occasion, string[]]> = [
  ["brunch", ["brunch", "breakfast", "bagels", "diner", "cafe"]],
  ["coffee", ["cafe", "bagels", "coffee"]],
  ["lunch", ["quick", "pizza", "noodles", "tacos", "falafel", "dumplings", "bagels", "diner", "cafe", "sandwiches"]],
  ["drinks", ["cocktails", "wine", "rooftop", "bar", "brewery"]],
];

export function mealsFor(venue: Venue): Occasion[] {
  if (venue.meals?.length) return venue.meals;
  const found = new Set<Occasion>(["dinner"]); // almost everything serves dinner
  for (const [occasion, tags] of MEAL_TAGS) {
    if (venue.tags.some((t) => tags.includes(t))) found.add(occasion);
  }
  return [...found];
}

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
  occasion: Occasion = "dinner",
): FilterResult {
  const survivors: Survivor[] = [];
  const rejected: Rejection[] = [];

  for (const venue of venues) {
    // Checked first: a BBQ joint is not a brunch option at any price, so
    // attributing it to budget would send people to flex the wrong thing.
    if (!mealsFor(venue).includes(occasion)) {
      rejected.push({ venueId: venue.id, failedOn: "occasion" });
      continue;
    }

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
