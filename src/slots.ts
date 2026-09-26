import type { HandleDMInput, HandleDMResult, RequiredSlot, Slots, UserDoc } from "./contracts.ts";
import { REQUIRED_SLOTS } from "./contracts.ts";
import { extract } from "./agent/extract.ts";
import type { Store } from "./db.ts";
import { resolveSlots } from "./resolve/index.ts";

// B owns this copy because only B knows which slot is still open. A sends the
// string back over Spectrum unchanged.
const QUESTIONS: Record<RequiredSlot, string> = {
  budgetCapUSD: "Roughly what's your budget tonight? A number or just \"cheap\" both work.",
  dietary: "Anything I should plan around food-wise? \"I eat everything\" is a fine answer.",
  window: "What time works for you? Something like \"after 7\" or \"6 to 10\".",
  home: "Where are you coming from? A neighborhood, a landmark or an address.",
  maxTravelMin: "How far are you up for travelling? e.g. \"30 min\" or \"not far\".",
};

const DONE = "Got everything I need. Working it out with the others now.";

export function missingSlots(slots: Slots): RequiredSlot[] {
  return REQUIRED_SLOTS.filter((key) => slots[key]?.value === undefined || slots[key]?.value === null);
}

// One question at a time: people answer out of order, and a wall of questions
// gets one answer back.
export function nextQuestion(missing: RequiredSlot[]): string {
  const next = missing[0];
  return next ? QUESTIONS[next] : DONE;
}

// A's standing profile write must not clobber these, which is why seeding only
// fills slots the person has not answered in this plan.
function seedFromProfile(slots: Slots, user: UserDoc | null): Slots {
  if (!user) return slots;
  const seeded: Slots = { ...slots };
  const { home, dietary, defaultBudgetUSD, tastes, preferredSpots } = user.profile;

  if (!seeded.home && home) seeded.home = { raw: home.label, value: home, confidence: "high" };
  if (!seeded.dietary && dietary) {
    seeded.dietary = { raw: dietary.join(", "), value: dietary, confidence: "high" };
  }
  if (!seeded.budgetCapUSD && typeof defaultBudgetUSD === "number") {
    seeded.budgetCapUSD = { raw: `${defaultBudgetUSD}`, value: defaultBudgetUSD, confidence: "low" };
  }
  seeded.tags = [...new Set([...(seeded.tags ?? []), ...tastes])];
  seeded.namedSpots = [...new Set([...(seeded.namedSpots ?? []), ...preferredSpots])];
  return seeded;
}

// Contract 2. A resolves sender and plan, then calls this with the raw text.
export async function handleDM(input: HandleDMInput, store: Store): Promise<HandleDMResult> {
  const existing = await store.getSlots(input.planId, input.userId);
  const user = await store.getUser(input.userId);

  const raw = await extract(input.text);
  const resolved = await resolveSlots(raw, seedFromProfile(existing, user));

  await store.setSlots(input.planId, input.userId, resolved);

  const missing = missingSlots(resolved);
  return { slots: resolved, missing, reply: nextQuestion(missing) };
}
