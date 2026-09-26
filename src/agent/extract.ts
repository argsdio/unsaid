import { GROK_MODEL, grok } from "../grok.ts";
import type { RawSlots } from "../resolve/index.ts";
import { resolveBudget, resolveTravelMin, resolveWindow } from "../resolve/index.ts";
import { resolveDietary } from "../resolve/dietary.ts";
import { resolveHome } from "../resolve/location.ts";

const SCHEMA = {
  type: "object",
  properties: {
    budgetRaw: { type: "string", description: "their words about money, e.g. '$25 tops'" },
    dietaryRaw: { type: "string", description: "their words about food limits, e.g. 'I eat everything'" },
    windowRaw: { type: "string", description: "their words about timing, e.g. 'after 7'" },
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
  "Pull planning details out of one text message about dinner plans.",
  "Copy the person's OWN WORDS verbatim into each field. Do not normalise,",
  "translate, or invent values. Omit any field the message does not mention.",
].join(" ");

// Every resolver gets a look at the whole message and only the ones that
// recognise something contribute. Used when no key is set, so slot-filling still
// works offline.
export function extractOffline(text: string): RawSlots {
  const raw: RawSlots = {};
  if (resolveBudget(text).value !== null) raw.budgetRaw = text;
  if (resolveDietary(text).slot.value !== null) raw.dietaryRaw = text;
  if (resolveWindow(text).value !== null) raw.windowRaw = text;
  if (resolveTravelMin(text).value !== null) raw.travelRaw = text;
  return raw;
}

export async function extract(text: string): Promise<RawSlots> {
  const client = grok();
  if (!client) {
    const offline = extractOffline(text);
    const home = await resolveHome(text);
    if (home.value !== null) offline.homeRaw = text;
    return offline;
  }

  try {
    const response = await client.chat.completions.create({
      model: GROK_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: { name: "slots", schema: SCHEMA, strict: false },
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    });
    const content = response.choices[0]?.message.content;
    if (!content) return extractOffline(text);
    return JSON.parse(content) as RawSlots;
  } catch {
    return extractOffline(text);
  }
}
