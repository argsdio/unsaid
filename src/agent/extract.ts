import type { RequiredSlot, StoredMessage } from "../contracts.ts";
import { GROK_MODEL, grok } from "../grok.ts";
import type { RawSlots } from "../resolve/index.ts";
import { resolveBudget, resolveTravelMin, resolveWindow } from "../resolve/index.ts";
import { resolveBlackouts } from "../resolve/blackout.ts";
import { resolveDietary } from "../resolve/dietary.ts";
import { resolveHome } from "../resolve/location.ts";

export type ExtractContext = {
  history?: StoredMessage[];
  expecting?: RequiredSlot | "blackouts";
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

  if (brief && expecting) {
    const only: RawSlots = {};
    if (expecting === "budgetCapUSD" && raw.budgetRaw) only.budgetRaw = raw.budgetRaw;
    if (expecting === "maxTravelMin" && raw.travelRaw) only.travelRaw = raw.travelRaw;
    if (expecting === "window" && raw.windowRaw) only.windowRaw = raw.windowRaw;
    if (expecting === "dietary" && raw.dietaryRaw) only.dietaryRaw = raw.dietaryRaw;
    if (expecting === "blackouts" && raw.blackoutRaw) only.blackoutRaw = raw.blackoutRaw;
    if (Object.keys(only).length > 0) return only;
  }

  return raw;
}

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
): Promise<RawSlots> {
  const raw = extractOffline(text, expecting);
  if (!raw.homeRaw && (await resolveHome(text)).value !== null) raw.homeRaw = text;
  return raw;
}

export async function extract(text: string, ctx: ExtractContext = {}): Promise<RawSlots> {
  const client = grok();
  const offline = await offlineExtraction(text, ctx.expecting);
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
