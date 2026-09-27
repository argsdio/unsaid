import type { RequiredSlot, StoredMessage } from "../contracts.ts";
import { GROK_MODEL, grok } from "../grok.ts";
import type { RawSlots } from "../resolve/index.ts";
import { resolveBudget, resolveTravelMin, resolveWindow } from "../resolve/index.ts";
import { resolveBlackouts } from "../resolve/blackout.ts";
import { resolveDietary } from "../resolve/dietary.ts";
import { type Geocoder, resolveHome } from "../resolve/location.ts";

export type ExtractContext = {
  history?: StoredMessage[];
  expecting?: RequiredSlot | "blackouts";
  geocode?: Geocoder;
};

const SCHEMA = {
  type: "object",
  properties: {
    budgetRaw: { type: "string", description: "their words about money, e.g. '$25 tops'" },
    dietaryRaw: { type: "string", description: "their words about food limits, e.g. 'I eat everything'" },
    windowRaw: { type: "string", description: "their words about timing tonight, e.g. 'after 7'" },
    blackoutRaw: { type: "string", description: "recurring times that never work, e.g. 'class on tuesdays'" },
    homeRaw: { type: "string", description: "their words about location: neighborhood, landmark or address" },
    travelRaw: { type: "string", description: "their words about how far they will go" },
    tags: { type: "array", items: { type: "string" }, description: "loose taste words" },
    namedSpots: { type: "array", items: { type: "string" }, description: "specific places they named" },
  },
  additionalProperties: false,
} as const;

// Grok returns the person's phrasing, never canonical values -- resolution is
// code's job, so a model that invents "LES" instead of "Lower East Side" cannot
// silently break the filter.
const SYSTEM = [
  "Pull planning details out of the latest message in a text conversation about plans.",
  "Copy the person's OWN WORDS verbatim into each field. Do not normalise,",
  "translate, or invent values. Omit any field the latest message does not address.",
  "Earlier messages are context for resolving what a short reply refers to:",
  "if the last question asked about budget and they reply '30', that is budgetRaw.",
].join(" ");

// Every resolver gets a look at the whole message and the ones that recognise
// something contribute. Used when no key is set, so slot-filling works offline.
//
// `expecting` disambiguates bare replies: "30" resolves as both a budget and a
// travel cap, so on a short message we trust the slot we just asked about.
export function extractOffline(text: string, expecting?: ExtractContext["expecting"]): RawSlots {
  const raw: RawSlots = {};
  const brief = text.trim().split(/\s+/).length <= 4;

  if (resolveBudget(text).value !== null) raw.budgetRaw = text;
  if (resolveDietary(text).slot.value !== null) raw.dietaryRaw = text;
  if (resolveWindow(text).value !== null) raw.windowRaw = text;
  if (resolveTravelMin(text).value !== null) raw.travelRaw = text;
  if (resolveBlackouts(text).length > 0) raw.blackoutRaw = text;

  // budgetRaw and travelRaw come from resolvers that will claim almost any bare
  // number, so on a brief answer they may only fill the slot actually being
  // asked about. That is how "around 7:30" became a $30 budget and "60th and
  // lex" became $60.
  //
  // The non-greedy slots need recognisable words, so they stay allowed from any
  // brief answer -- somebody correcting "i eat everything" while being asked the
  // time must still be heard.
  if (brief && expecting) {
    const field = RAW_FIELD[expecting];
    const trimmed: RawSlots = {};
    for (const [key, value] of Object.entries(raw)) {
      if (GREEDY_FIELDS.has(key) && key !== field) continue;
      (trimmed as Record<string, unknown>)[key] = value;
    }
    return trimmed;
  }

  return raw;
}

// Which raw field each slot answer belongs in. `home` was missing, which is why
// "60th and lex" leaked its 60 into the budget.
const RAW_FIELD: Record<NonNullable<ExtractContext["expecting"]>, keyof RawSlots> = {
  home: "homeRaw",
  window: "windowRaw",
  maxTravelMin: "travelRaw",
  dietary: "dietaryRaw",
  budgetCapUSD: "budgetRaw",
  blackouts: "blackoutRaw",
};

// Resolvers that will claim a bare number. windowRaw joined them once a bare
// clock became valid, so "8" answering the budget question no longer sets 8pm.
const GREEDY_FIELDS = new Set<string>(["budgetRaw", "travelRaw", "windowRaw"]);

const STRING_FIELDS = [
  "budgetRaw",
  "dietaryRaw",
  "windowRaw",
  "blackoutRaw",
  "homeRaw",
  "travelRaw",
] as const;

// `strict: false` is required so the model can omit fields, which means nothing
// enforces the schema. A number where a string belongs would throw inside a
// resolver, well past any try/catch here.
function coerce(parsed: unknown): RawSlots {
  const out: RawSlots = {};
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;

  for (const key of STRING_FIELDS) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  for (const key of ["tags", "namedSpots"] as const) {
    const value = obj[key];
    if (!Array.isArray(value)) continue;
    const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (strings.length) out[key] = strings;
  }
  return out;
}

// Grok is more precise about which phrase belongs to which slot; the offline
// resolvers are better at not missing one. Grok wins every field it fills.
function mergeExtractions(primary: RawSlots, fallback: RawSlots): RawSlots {
  const merged: RawSlots = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

// Location needs an async resolver, so it sits outside extractOffline. Used by
// both the no-key path and the failure path, so a Grok outage degrades to
// exactly the same quality as running with no key at all.
async function offlineExtraction(
  text: string,
  expecting: ExtractContext["expecting"],
  geocode?: Geocoder,
): Promise<RawSlots> {
  const raw = extractOffline(text, expecting);
  if (raw.homeRaw) return raw;

  // Previously homeRaw was set only when resolveHome had ALREADY succeeded, so a
  // gazetteer miss meant resolveSlots never even attempted the slot. If we asked
  // about home, the answer is a home attempt regardless of whether we can read
  // it yet -- the resolver and then the retry ladder decide what happens next.
  if (expecting === "home") {
    raw.homeRaw = text;
  } else if ((await resolveHome(text, geocode)).value !== null) {
    raw.homeRaw = text;
  }
  return raw;
}

export async function extract(text: string, ctx: ExtractContext = {}): Promise<RawSlots> {
  const client = grok();
  const offline = await offlineExtraction(text, ctx.expecting, ctx.geocode);
  if (!client) return offline;

  try {
    // The caller stores the inbound message before reading history, so drop it
    // rather than sending the same turn twice.
    const prior = (ctx.history ?? []).filter((m) => !(m.direction === "in" && m.text === text));
    const recent = prior.slice(-6);
    const response = await client.chat.completions.create({
      model: GROK_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: { name: "slots", schema: SCHEMA, strict: false },
      },
      messages: [
        { role: "system", content: SYSTEM },
        ...(ctx.expecting
          ? [{ role: "system" as const, content: `The last question asked about: ${ctx.expecting}` }]
          : []),
        ...recent.map((m) => ({
          role: (m.direction === "in" ? "user" : "assistant") as "user" | "assistant",
          content: m.text,
        })),
        { role: "user", content: text },
      ],
    });
    const content = response.choices[0]?.message.content;
    if (!content) {
      console.warn(`[extract] ${GROK_MODEL} returned no content; using offline extraction`);
      return offline;
    }
    return mergeExtractions(coerce(JSON.parse(content)), offline);
  } catch (error) {
    // Loud on purpose. A wrong model name or a rejected schema is otherwise
    // indistinguishable from success, with extraction just quietly worse.
    console.warn(
      `[extract] ${GROK_MODEL} failed, using offline extraction: ${(error as Error).message}`,
    );
    return offline;
  }
}
