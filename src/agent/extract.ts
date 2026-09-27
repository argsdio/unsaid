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

export async function extract(text: string, ctx: ExtractContext = {}): Promise<RawSlots> {
  const client = grok();
  if (!client) {
    const offline = extractOffline(text, ctx.expecting);
    if (!offline.homeRaw && (await resolveHome(text)).value !== null) offline.homeRaw = text;
    return offline;
  }

  try {
    const recent = (ctx.history ?? []).slice(-6);
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
    if (!content) return extractOffline(text, ctx.expecting);
    return JSON.parse(content) as RawSlots;
  } catch {
    return extractOffline(text, ctx.expecting);
  }
}
