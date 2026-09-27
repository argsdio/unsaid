import { readFileSync } from "node:fs";
import type {
  Coords,
  DietaryTag,
  FilterResult,
  Occasion,
  MergedConstraints,
  Rejection,
  Survivor,
  TimeWindow,
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
// Enough of the window to actually sit down. Without a minimum, a place that
// shuts ten minutes after everyone arrives counts as open.
const USABLE_MINUTES = 45;

function minutesInto(iso: string): { day: number; at: number } {
  const d = new Date(iso);
  return { day: d.getDay(), at: d.getHours() * 60 + d.getMinutes() };
}

// Absent hours mean unknown, never closed: a fifth of the catalogue is
// hand-written, and dropping those would quietly shrink the demo to whatever
// Google happened to match.
export function isOpenDuring(venue: Venue, window: TimeWindow): boolean {
  if (!venue.hours?.length) return true;
  const from = minutesInto(window.start);
  const to = minutesInto(window.end);
  const end = to.at > from.at ? to.at : to.at + 24 * 60;
  const need = Math.min(USABLE_MINUTES, end - from.at);

  for (const period of venue.hours) {
    // A close earlier than its open runs past midnight, so the same period is
    // also the tail end of the previous day.
    const spans = period.close <= period.open
      ? [{ day: period.day, open: period.open, close: period.close + 24 * 60 }]
      : [{ day: period.day, open: period.open, close: period.close }];
    for (const span of spans) {
      for (const shift of [0, 24 * 60]) {
        const dayOfSpan = shift === 0 ? span.day : (span.day + 1) % 7;
        if (dayOfSpan !== from.day) continue;
        const overlap = Math.min(end, span.close - shift) - Math.max(from.at, span.open - shift);
        if (overlap >= need) return true;
      }
    }
  }
  return false;
}

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

    // Before money, for the same reason as the occasion: a closed restaurant is
    // not a budget problem, and nobody can flex their way into it.
    if (!isOpenDuring(venue, merged.window)) {
      rejected.push({ venueId: venue.id, failedOn: "closed" });
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
// Loose enough that "i love joes pizza" finds Joe's Pizza, tight enough that a
// catalogue containing venues called Post, Bite, Folk and Ops does not match
// them inside an ordinary sentence. The longest match wins, so "max soha" beats
// a venue merely called Max.
// A placeId is the unambiguous handle; a name search is the fallback for the
// hand-written entries Places never matched.
export function mapsLink(venue: Venue): string {
  if (venue.placeId) return `https://www.google.com/maps/place/?q=place_id:${venue.placeId}`;
  const q = encodeURIComponent(`${venue.name} ${venue.neighborhood} New York`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// Transit, because this is New York and nobody is driving to dinner. `from` is
// the person's own home, so everyone gets directions from where they actually
// are rather than a link they have to retype.
export function transitLink(venue: Venue, from?: Coords): string {
  const parts = [
    "https://www.google.com/maps/dir/?api=1",
    `destination=${venue.lat},${venue.lng}`,
    venue.placeId ? `destination_place_id=${venue.placeId}` : "",
    from ? `origin=${from.lat},${from.lng}` : "",
    "travelmode=transit",
  ].filter(Boolean);
  return parts.join("&");
}

export function findVenueByName(text: string): Venue | undefined {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const needle = flat(text);
  if (needle.length < 4) return undefined;

  let best: Venue | undefined;
  for (const v of VENUES) {
    const name = flat(v.name);
    if (name.length < 4) continue;
    const mentioned = name.length >= 6 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(needle);
    const typed = name.startsWith(needle) || (needle.length >= 6 && name.includes(needle));
    if (!mentioned && !typed) continue;
    if (!best || name.length > flat(best.name).length) best = v;
  }
  return best;
}
