import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import type { Occasion, OpenPeriod, Venue } from "../src/contracts.ts";
import { DIETARY_TAGS } from "../src/contracts.ts";
import { PLACES } from "../src/resolve/gazetteer.ts";

// A build step, not a runtime call: this writes src/venues.json and the result
// is committed. The app never needs a key, the demo cannot be broken by a quota,
// and a schema change arrives in a reviewable diff.
//
//   npm run venues                 enrich the catalogue, then discover new places
//   npm run venues -- --dry        print what would change, write nothing
//   npm run venues -- --enrich     only fill in hours/ratings for what we have
//   npm run venues -- --discover   only look for places we do not have
//   npm run venues -- --only coffee,drinks
//   npm run venues -- --max 20     stop after N requests (a cheap trial run)

const KEY_NAMES = [
  "GOOGLE_PLACES_API_KEY",
  "GOOGLE_PLACES_KEY",
  "PLACES_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "GOOGLE_API_KEY",
];

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const valueOf = (flag: string) => {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  if (hit) return hit.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has("--dry");
const MAX_REQUESTS = Number(valueOf("--max") ?? 400);
const DO_ENRICH = !has("--discover");
const DO_DISCOVER = !has("--enrich");

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location",
  "places.priceLevel", "places.priceRange", "places.types", "places.primaryType", "places.rating",
  "places.userRatingCount", "places.businessStatus", "places.regularOpeningHours",
  "places.servesBreakfast", "places.servesBrunch", "places.servesLunch",
  "places.servesDinner", "places.servesCoffee", "places.servesDessert",
  "places.servesBeer", "places.servesWine", "places.servesCocktails",
  "places.servesVegetarianFood",
].join(",");

// Neighbourhoods the demo actually plans in, Morningside Heights and Harlem
// first because the hackathon is at Columbia.
const HOODS: Array<[string, string]> = [
  ["morningside heights", "Morningside Heights"], ["harlem", "Harlem"],
  ["upper west side", "Upper West Side"], ["east village", "East Village"],
  ["west village", "West Village"], ["greenwich village", "Greenwich Village"],
  ["lower east side", "Lower East Side"], ["chinatown", "Chinatown"],
  ["soho", "Soho"], ["koreatown", "Koreatown"], ["chelsea", "Chelsea"],
  ["flatiron", "Flatiron"], ["hells kitchen", "Hell's Kitchen"],
  ["upper east side", "Upper East Side"], ["williamsburg", "Williamsburg"],
  ["greenpoint", "Greenpoint"], ["bushwick", "Bushwick"],
  ["park slope", "Park Slope"], ["long island city", "Long Island City"],
  ["astoria", "Astoria"], ["jackson heights", "Jackson Heights"],
  ["flushing", "Flushing"],
];

const QUERIES: Array<{ occasion: Occasion; query: string; cuisine?: string }> = [
  { occasion: "brunch", query: "brunch" },
  { occasion: "lunch", query: "lunch spot" },
  { occasion: "dinner", query: "dinner restaurant" },
  { occasion: "drinks", query: "cocktail bar", cuisine: "cocktails" },
  { occasion: "drinks", query: "beer bar", cuisine: "beer" },
  { occasion: "coffee", query: "coffee shop", cuisine: "coffee" },
  { occasion: "coffee", query: "bubble tea", cuisine: "boba" },
];

// Per-person spend for one outing, which is not what Google's price_level means.
// A $$ coffee shop and a $$ steakhouse are not the same bill, so the bucket
// depends on what kind of outing the place is for.
const SPEND: Record<string, Record<string, number>> = {
  drink: { PRICE_LEVEL_INEXPENSIVE: 12, PRICE_LEVEL_MODERATE: 20, PRICE_LEVEL_EXPENSIVE: 30, PRICE_LEVEL_VERY_EXPENSIVE: 45 },
  cafe:  { PRICE_LEVEL_INEXPENSIVE: 8,  PRICE_LEVEL_MODERATE: 14, PRICE_LEVEL_EXPENSIVE: 22, PRICE_LEVEL_VERY_EXPENSIVE: 30 },
  food:  { PRICE_LEVEL_INEXPENSIVE: 14, PRICE_LEVEL_MODERATE: 30, PRICE_LEVEL_EXPENSIVE: 60, PRICE_LEVEL_VERY_EXPENSIVE: 110 },
};

type Place = {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
  priceLevel?: string;
  priceRange?: { startPrice?: { units?: string }; endPrice?: { units?: string } };
  types?: string[];
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  regularOpeningHours?: { periods?: Array<{ open?: { day?: number; hour?: number; minute?: number }; close?: { day?: number; hour?: number; minute?: number } }> };
  servesBreakfast?: boolean; servesBrunch?: boolean; servesLunch?: boolean;
  servesDinner?: boolean; servesCoffee?: boolean; servesDessert?: boolean;
  servesBeer?: boolean; servesWine?: boolean; servesCocktails?: boolean;
  servesVegetarianFood?: boolean;
};

function keyFromEnv(): { name: string; value: string } | null {
  for (const name of KEY_NAMES) {
    const value = process.env[name];
    if (value?.trim()) return { name, value: value.trim() };
  }
  return null;
}

let requests = 0;
async function search(key: string, textQuery: string, at: { lat: number; lng: number }): Promise<Place[]> {
  if (requests >= MAX_REQUESTS) return [];
  requests += 1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify({
        textQuery,
        maxResultCount: 20,
        locationBias: { circle: { center: { latitude: at.lat, longitude: at.lng }, radius: 1200 } },
      }),
    });
    if (res.ok) return ((await res.json()) as { places?: Place[] }).places ?? [];
    const body = await res.text();
    // 403 and 400 are configuration, not luck: retrying wastes quota and time.
    if (res.status === 400 || res.status === 403) {
      throw new Error(`Places refused the request (${res.status}). ${body.slice(0, 300)}`);
    }
    console.warn(`  [${res.status}] retrying "${textQuery}" (${attempt}/3)`);
    await new Promise((r) => setTimeout(r, attempt * 800));
  }
  return [];
}

const TYPE_CUISINE: Array<[string, string]> = [
  ["coffee_shop", "coffee"], ["cafe", "cafe"], ["bakery", "bakery"],
  ["bar", "cocktails"], ["pub", "beer"], ["wine_bar", "wine"],
  ["ice_cream_shop", "dessert"], ["dessert_shop", "dessert"],
  ["bagel_shop", "bagels"], ["deli", "deli"], ["sandwich_shop", "sandwiches"],
  ["pizza_restaurant", "pizza"], ["hamburger_restaurant", "burgers"],
  ["sushi_restaurant", "japanese"], ["ramen_restaurant", "japanese"],
  ["breakfast_restaurant", "american"], ["brunch_restaurant", "american"],
  ["steak_house", "steak"], ["seafood_restaurant", "seafood"],
  ["barbecue_restaurant", "bbq"], ["vegan_restaurant", "vegan"],
  ["vegetarian_restaurant", "vegetarian"], ["tea_house", "boba"],
  ["juice_shop", "cafe"], ["donut_shop", "bakery"], ["diner", "diner"],
];

function cuisineOf(place: Place, fallback?: string): string | undefined {
  const types = place.types ?? [];
  const primary = place.primaryType ?? "";
  // "thai_restaurant" carries the cuisine in its own name.
  for (const t of [primary, ...types]) {
    const m = /^([a-z_]+)_restaurant$/.exec(t);
    const word = m?.[1]?.replace(/_/g, "-");
    if (word && !["fast-food", "fine-dining", "family", "chinese-style", "asian"].includes(word) && !DIETARY_TAGS.includes(word as never)) {
      const named = TYPE_CUISINE.find(([k]) => k === t);
      return named && !DIETARY_TAGS.includes(named[1] as never) ? named[1] : word;
    }
  }
  for (const [type, cuisine] of TYPE_CUISINE) {
    if ((primary === type || types.includes(type)) && !DIETARY_TAGS.includes(cuisine as never)) return cuisine;
  }
  return fallback;
}

const CAFE_TYPES = ["coffee_shop", "cafe", "bakery", "tea_house", "ice_cream_shop", "dessert_shop", "juice_shop", "donut_shop", "candy_store", "chocolate_shop"];
const BAR_TYPES = ["bar", "pub", "wine_bar", "bar_and_grill", "night_club"];

// Used for both what it is open for and what it costs: a $$ coffee shop and a
// $$ steakhouse are not the same bill.
function kindOf(place: Place): "drink" | "cafe" | "food" {
  const primary = place.primaryType ?? "";
  if (BAR_TYPES.includes(primary)) return "drink";
  if (CAFE_TYPES.includes(primary)) return "cafe";
  return "food";
}

function mealsOf(place: Place, fallback: Occasion): Occasion[] {
  const meals = new Set<Occasion>();
  if (place.servesBrunch || place.servesBreakfast) meals.add("brunch");
  if (place.servesLunch) meals.add("lunch");
  if (place.servesDinner) meals.add("dinner");
  if (place.servesCoffee || place.servesDessert) meals.add("coffee");
  if (place.servesCocktails || place.servesBeer || place.servesWine) meals.add("drinks");

  // Google sets servesCoffee on any restaurant that will sell you a coffee, and
  // servesWine on any that has a wine list. Neither makes it a place you would
  // go *for* coffee or *for* a drink, and both flooded every occasion with
  // restaurants. The primary type decides.
  const kind = kindOf(place);
  const isCafe = kind === "cafe";
  const isBar = kind === "drink";
  if (isCafe) meals.add("coffee");
  else if (!(place.servesCoffee && !place.servesDinner)) meals.delete("coffee");
  if (isBar) meals.add("drinks");
  else meals.delete("drinks");
  if (meals.size === 0) {
    // The fallback is the query we ran, and it has to obey the same rule: a
    // burger joint turned up by a "cocktail bar" query is not a place for drinks
    // just because nothing else is known about it.
    const safe = fallback === "drinks" && !isBar ? "dinner" : fallback === "coffee" && !isCafe ? "lunch" : fallback;
    meals.add(safe);
  }
  return [...meals];
}

// A dietary tag is a hard filter in filterVenues, so it may never be guessed.
// Google labelled a beer parlour `vegan_restaurant` -- tagging that vegan would
// send a vegan somewhere they cannot eat, which is the one failure that matters
// more than an empty shortlist.
function tagsOf(place: Place, cuisine: string | undefined, name: string): string[] {
  const tags = new Set<string>();
  const notDietary = (t: string) => !DIETARY_TAGS.includes(t as never);
  if (cuisine && notDietary(cuisine)) tags.add(cuisine);
  for (const t of place.types ?? []) {
    const named = TYPE_CUISINE.find(([k]) => k === t);
    if (named && notDietary(named[1])) tags.add(named[1]);
    const m = /^([a-z_]+)_restaurant$/.exec(t);
    const word = m?.[1]?.replace(/_/g, "-");
    if (word && word !== "fast-food" && notDietary(word)) tags.add(word);
  }
  if (place.servesVegetarianFood) tags.add("vegetarian");
  if (place.servesCocktails) tags.add("cocktails");
  if (place.servesBeer) tags.add("beer");
  if (place.servesWine) tags.add("wine");
  // Places has no halal or kosher field, so only the place's own name may claim
  // one, and then only as a whole word.
  const said = ` ${name.toLowerCase()} `;
  for (const tag of ["halal", "kosher", "vegan"] as const) {
    if (new RegExp(`\\b${tag}\\b`).test(said)) tags.add(tag);
  }
  return [...tags];
}

function hoursOf(place: Place): OpenPeriod[] | undefined {
  const periods = place.regularOpeningHours?.periods;
  if (!periods?.length) return undefined;
  const out: OpenPeriod[] = [];
  for (const p of periods) {
    if (p.open?.day === undefined) continue;
    // No `close` means open 24 hours on that day.
    const open = (p.open.hour ?? 0) * 60 + (p.open.minute ?? 0);
    const close = p.close ? (p.close.hour ?? 0) * 60 + (p.close.minute ?? 0) : 24 * 60 - 1;
    out.push({ day: p.open.day, open, close });
  }
  return out.length ? out : undefined;
}

function spendOf(place: Place): number | null {
  // Some listings carry a real dollar range, which beats a four-way bucket.
  const lo = Number(place.priceRange?.startPrice?.units ?? NaN);
  const hi = Number(place.priceRange?.endPrice?.units ?? NaN);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > 0) return Math.round((lo + hi) / 2);
  if (Number.isFinite(lo) && lo > 0) return Math.round(lo * 1.4);
  const level = place.priceLevel;
  if (!level) return null;
  return SPEND[kindOf(place)]![level] ?? null;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/['’.]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

const flatten = (s: string) => s.toLowerCase().replace(/['’.&,]/g, "").replace(/\s+/g, " ").trim();

// A 1200m bias radius spills over, so a Harlem bar found by a Morningside
// Heights query was being labelled Morningside Heights.
function nearestHood(lat: number, lng: number): string {
  let best = HOODS[0]!;
  let bestKm = Infinity;
  for (const hood of HOODS) {
    const at = PLACES[hood[0]]!;
    const km = Math.hypot((at.lat - lat) * 111, (at.lng - lng) * 84);
    if (km < bestKm) { bestKm = km; best = hood; }
  }
  return best[1];
}

// Real listings carry marketing in the name field. Left alone these arrive on
// somebody's phone as "ELIS WINE BAR & RESTAURANT".
function tidyName(raw: string): string | null {
  let name = raw.replace(/[^\p{Script=Latin}\p{N}\p{P}\p{Zs}]+/gu, " ").replace(/\s+/g, " ").trim();
  name = name.split(/\s+[-–—|]\s+/)[0]!.trim();
  // Listings arrive as "ELIS WINE BAR" and as "maman", and both land on a phone.
  if (name.length > 3 && (name === name.toUpperCase() || name === name.toLowerCase())) {
    name = name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "and");
  }
  return name.length >= 2 && name.length <= 38 && /\p{L}{2}/u.test(name) ? name : null;
}

async function main() {
  const key = keyFromEnv();
  if (!key) {
    console.error(
      [
        "No Places key in the environment.",
        "",
        `Add one line to .env (any of these names works): ${KEY_NAMES.join(", ")}`,
        "",
        "  GOOGLE_PLACES_API_KEY=your-key-here",
        "",
        "Get the key at https://console.cloud.google.com → APIs & Services →",
        "enable 'Places API (New)' → Credentials → Create credentials → API key.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`Using ${key.name} from the environment (${key.value.length} characters, not printed).`);

  const path = new URL("../src/venues.json", import.meta.url);
  const venues: Venue[] = JSON.parse(readFileSync(path, "utf8"));
  const byName = new Map(venues.map((v) => [flatten(v.name), v]));
  const byPlaceId = new Map(venues.flatMap((v) => (v.placeId ? [[v.placeId, v] as const] : [])));

  const only = (valueOf("--only") ?? "").split(",").filter(Boolean);
  let enriched = 0;
  let added = 0;
  const skipped: string[] = [];
  const closed: string[] = [];

  if (DO_ENRICH) {
    console.log(`\nEnriching ${venues.length} existing venues…`);
    for (const v of venues) {
      const at = { lat: v.lat, lng: v.lng };
      const found = await search(key.value, `${v.name} ${v.neighborhood} New York`, at);
      const near = (p: Place) =>
        !p.location ||
        Math.hypot((p.location.latitude - at.lat) * 111, (p.location.longitude - at.lng) * 84) <= 2.5;
      // Chains have branches in other cities. Without this the catalogue moved
      // Chotto Matte to London, 5,500km outside the travel model.
      const sameName = found.filter((p) => flatten(p.displayName?.text ?? "") === flatten(v.name) && near(p));
      const match = sameName[0] ?? found.filter(near)[0];
      if (!match || flatten(match.displayName?.text ?? "").slice(0, 6) !== flatten(v.name).slice(0, 6)) {
        skipped.push(`no match: ${v.name}`);
        continue;
      }
      if (match.businessStatus && match.businessStatus !== "OPERATIONAL") {
        // Proposing a restaurant that has closed down is the worst thing this
        // catalogue can do, so it leaves rather than staying unenriched.
        closed.push(`${v.name} (${match.businessStatus === "CLOSED_PERMANENTLY" ? "closed" : "temporarily closed"})`);
        continue;
      }
      v.placeId = match.id;
      if (match.location) { v.lat = match.location.latitude; v.lng = match.location.longitude; }
      if (match.rating) v.rating = match.rating;
      if (match.userRatingCount) v.ratingCount = match.userRatingCount;
      const hours = hoursOf(match);
      if (hours) v.hours = hours;
      // Meals are the union: Google knows a bar does dinner, we know a brunch
      // place is where you would go for brunch. Neither alone is complete.
      const theirs = mealsOf(match, v.meals?.[0] ?? "dinner");
      v.meals = [...new Set([...(v.meals ?? []), ...theirs])];
      if (match.servesVegetarianFood && !v.tags.includes("vegetarian")) v.tags.push("vegetarian");
      enriched += 1;
      if (enriched % 20 === 0) console.log(`  …${enriched}`);
    }
  }

  if (DO_DISCOVER) {
    const wanted = QUERIES.filter((q) => only.length === 0 || only.includes(q.occasion));
    console.log(`\nLooking for new places: ${wanted.length} queries × ${HOODS.length} neighbourhoods…`);
    for (const [hood, display] of HOODS) {
      const at = PLACES[hood];
      if (!at) throw new Error(`no gazetteer entry for ${hood}`);
      for (const q of wanted) {
        const found = await search(key.value, `${q.query} in ${display} New York`, at);
        // Google returns 20 ranked results; the tail is where the quality goes.
        let takenHere = 0;
        for (const place of found) {
          if (takenHere >= 8) break;
          const name = tidyName(place.displayName?.text ?? "");
          if (!name) continue;
          if (byPlaceId.has(place.id) || byName.has(flatten(name))) continue;
          if (place.businessStatus && place.businessStatus !== "OPERATIONAL") continue;
          if ((place.userRatingCount ?? 0) < 100 || (place.rating ?? 0) < 4.0) continue;

          // A ramen shop turned up by a bubble-tea query is not a coffee outing.
          // Food occasions are forced, because Google often leaves servesLunch
          // unset; coffee and drinks are exactly the two where being that kind of
          // place is the whole point.
          const meals = mealsOf(place, q.occasion);
          if (!meals.includes(q.occasion)) {
            // Google explicitly saying servesBrunch is false is information; it
            // leaving every serves* field unset is not, and that is the only case
            // where the query we ran gets the benefit of the doubt.
            const knows = [place.servesBreakfast, place.servesBrunch, place.servesLunch, place.servesDinner]
              .some((v) => v !== undefined);
            const forceable = !knows && ["brunch", "lunch", "dinner"].includes(q.occasion);
            if (!forceable) { skipped.push(`not a ${q.occasion} place: ${name}`); continue; }
            meals.push(q.occasion);
          }
          const estCostUSD = spendOf(place);
          // A venue with no price cannot be filtered against a budget, and
          // guessing one is how somebody ends up with a bill they said no to.
          if (estCostUSD === null) { skipped.push(`no price: ${name}`); continue; }

          const kind = kindOf(place);
          const cuisine =
            cuisineOf(place, q.cuisine) ||
            (place.primaryType ?? "").replace(/_restaurant$/, "").replace(/_/g, " ") ||
            (kind === "drink" ? "cocktails" : kind === "cafe" ? "cafe" : "restaurant");
          const id = slug(name);
          if (venues.some((v) => v.id === id)) { skipped.push(`id clash: ${name}`); continue; }

          const venue: Venue = {
            id, name, estCostUSD,
            // Every drinks venue carries `bar`, so "is this a place for drinks?"
            // is answerable from the catalogue alone.
            tags: [...new Set([...tagsOf(place, cuisine, name), ...(kind === "drink" ? ["bar"] : [])])],
            neighborhood: place.location ? nearestHood(place.location.latitude, place.location.longitude) : display,
            lat: place.location?.latitude ?? at.lat,
            lng: place.location?.longitude ?? at.lng,
            cuisine, meals,
            placeId: place.id,
            ...(place.rating ? { rating: place.rating } : {}),
            ...(place.userRatingCount ? { ratingCount: place.userRatingCount } : {}),
            ...(hoursOf(place) ? { hours: hoursOf(place) } : {}),
          };
          venues.push(venue);
          byName.set(flatten(name), venue);
          byPlaceId.set(place.id, venue);
          added += 1;
          takenHere += 1;
        }
      }
      console.log(`  ${display}: ${added} new so far`);
    }
  }

  const closedNames = new Set(closed.map((c) => c.replace(/ \((closed|temporarily closed)\)$/, "")));
  const live = venues.filter((v) => !closedNames.has(v.name));

  const counts: Record<string, number> = {};
  for (const v of live) for (const m of v.meals ?? []) counts[m] = (counts[m] ?? 0) + 1;
  console.log(
    [
      "",
      `requests:  ${requests}`,
      `enriched:  ${enriched}`,
      `added:     ${added}`,
      `total:     ${live.length}`,
      `with hours: ${live.filter((v) => v.hours).length}`,
      closed.length ? `dropped as closed: ${closed.join(", ")}` : "",
      `by occasion: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ")}`,
      skipped.length ? `skipped ${skipped.length}: ${skipped.slice(0, 12).join("; ")}${skipped.length > 12 ? " …" : ""}` : "",
    ].filter(Boolean).join("\n"),
  );

  if (has("--show")) {
    for (const v of live.slice(-Math.min(added, 40))) {
      console.log(`  ${v.name} · ${v.cuisine} · $${v.estCostUSD} · ${v.neighborhood} · ${(v.meals ?? []).join("/")} · ${v.rating}(${v.ratingCount}) · ${v.hours?.length ?? 0} days · ${v.tags.join(",")}`);
    }
  }
  if (DRY) { console.log("\n--dry: nothing written."); return; }
  writeFileSync(path, `[\n${live.map((v) => JSON.stringify(v)).join(",\n")}\n]\n`);
  console.log(`\nWrote src/venues.json. Run \`npm run harness\` and commit the diff.`);
}

await main();
