import { readFileSync } from "node:fs";
import type {
  DietaryTag,
  FilterResult,
  Occasion,
  MergedConstraints,
  Rejection,
  Survivor,
  TravelProfile,
  Venue,
} from "./contracts.ts";
import { DIETARY_TAGS } from "./contracts.ts";
import { travelMin } from "./travel.ts";

export const VENUES: Venue[] = JSON.parse(
  readFileSync(new URL("./venues.json", import.meta.url), "utf8"),
) as Venue[];

// Every venue in the committed catalogue now carries `meals`, so this is the
// fallback for one added without it -- a Places-sourced entry would set them
// from real `types`.
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

export const PRICE_TIERS = ["$", "$$", "$$$", "$$$$"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

// Thresholds are per-person spend for one outing, not Google's price_level:
// $ is a slice-and-a-drink, $$$$ is a tasting menu.
export function priceTier(venue: Venue): PriceTier {
  if (venue.estCostUSD <= 15) return "$";
  if (venue.estCostUSD <= 30) return "$$";
  if (venue.estCostUSD <= 60) return "$$$";
  return "$$$$";
}

// What somebody means by "cheap" or "somewhere nice". Matched against tastes, so
// the vibe is scored rather than filtered -- a cap already filters on price.
const TIER_WORDS: Record<PriceTier, string[]> = {
  "$": ["cheap", "budget", "casual", "quick", "hole in the wall", "broke"],
  "$$": ["casual", "midrange", "normal", "chill"],
  "$$$": ["nice", "nicer", "upscale", "date", "fancy", "special"],
  "$$$$": ["fancy", "fine dining", "splurge", "blowout", "celebration", "special"],
};

// The catalogue is its own vocabulary: anything we can act on is a cuisine, a
// tag or a price word already in the data, so this list cannot drift from it.
const TASTE_WORDS = [
  ...new Set([
    ...VENUES.flatMap((v) => v.tags),
    ...VENUES.map((v) => v.cuisine ?? ""),
    ...Object.values(TIER_WORDS).flat(),
  ]),
].filter((w) => w.length > 2 && !DIETARY_TAGS.includes(w as DietaryTag));

export function tasteWords(text: string): string[] {
  const t = text.toLowerCase();
  return TASTE_WORDS.filter((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
}

export function matchesVibe(venue: Venue, phrases: string[]): boolean {
  const said = phrases.join(" ").toLowerCase();
  return said.length > 0 && TIER_WORDS[priceTier(venue)].some((w) => said.includes(w));
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
