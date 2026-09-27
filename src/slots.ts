import type {
  Blackout,
  HandleDMInput,
  HandleDMResult,
  RequiredSlot,
  Slots,
  UserDoc,
} from "./contracts.ts";
import { REQUIRED_SLOTS } from "./contracts.ts";
import { extract } from "./agent/extract.ts";
import type { Store } from "./db.ts";
import { type RawSlots, resolveSlots } from "./resolve/index.ts";
import { resolveBlackouts } from "./resolve/blackout.ts";
import { resolveDietary } from "./resolve/dietary.ts";
import { resolveHome } from "./resolve/location.ts";
import { clipWindow } from "./resolve/time.ts";
import { findVenueByName } from "./venues.ts";

// Money is asked LAST. The whole product exists because budget is the thing
// nobody wants to say out loud, so leading with it is the worst possible opener.
// REQUIRED_SLOTS stays the canonical set; this is only presentation order.
const ASK_ORDER: RequiredSlot[] = [
  "home",
  "window",
  "maxTravelMin",
  "dietary",
  "budgetCapUSD",
];

// B owns this copy because only B knows which slot is still open. A sends the
// string back over Spectrum unchanged.
const QUESTIONS: Record<RequiredSlot, string> = {
  home: "Where are you coming from tonight? A neighborhood, a landmark or an address.",
  window: "What time works for you? Something like \"after 7\" or \"6 to 10\".",
  maxTravelMin: "How far are you up for travelling? e.g. \"30 min\" or \"not far\".",
  dietary: "Anything I should plan around food-wise? \"I eat everything\" is a fine answer.",
  budgetCapUSD: "Last thing — roughly what are you thinking budget-wise? \"cheap\" works too.",
};

const DONE = "Got everything I need. Working it out with the others now.";

// Asked once, then reused across every future plan. Budget and availability are
// absent on purpose: both depend on the occasion, so they are asked every time.
type ProfileField = "home" | "dietary" | "blackouts" | "preferredSpots";

const PROFILE_ORDER: ProfileField[] = ["home", "dietary", "blackouts", "preferredSpots"];

const PROFILE_QUESTIONS: Record<ProfileField, string> = {
  home: "First time here — a few things and I'll remember them. Where do you usually head out from?",
  dietary: "Anything I should always plan around food-wise? \"I eat everything\" works.",
  blackouts: "Any times that never work for you? Like \"class on Tuesday nights\", or just \"none\".",
  preferredSpots: "Last one — any favourite places I should keep in mind?",
};

export function missingSlots(slots: Slots): RequiredSlot[] {
  return ASK_ORDER.filter((key) => {
    const value = slots[key]?.value;
    return value === undefined || value === null;
  });
}

// One question at a time: people answer out of order, and a wall of questions
// gets one answer back.
export function nextQuestion(missing: RequiredSlot[]): string {
  const next = missing[0];
  return next ? QUESTIONS[next] : DONE;
}

function blankUser(userId: string): UserDoc {
  return {
    _id: userId,
    phone: userId,
    profile: { tastes: [], preferredSpots: [] },
    askedProfile: [],
    wishlist: [],
  };
}

// Seeding fills gaps and never overwrites something the person said in this
// plan, which is also why A's profile writes cannot clobber a live answer.
function seedFromProfile(slots: Slots, user: UserDoc | null): { slots: Slots; used: string[] } {
  if (!user) return { slots, used: [] };
  const seeded: Slots = { ...slots };
  const used: string[] = [];
  const { home, dietary, tastes, preferredSpots } = user.profile;

  if (!seeded.home && home) {
    seeded.home = { raw: home.label, value: home, confidence: "high" };
    used.push(home.label);
  }
  // Seeded even when empty, so someone who already said they eat everything is
  // not asked again. Only mentioned in the recall line when there is something
  // to name.
  if (!seeded.dietary && dietary) {
    seeded.dietary = { raw: dietary.join(", "), value: dietary, confidence: "high" };
    if (dietary.length > 0) used.push(dietary.join(" and "));
  }
  seeded.tags = [...new Set([...(seeded.tags ?? []), ...tastes])];
  seeded.namedSpots = [...new Set([...(seeded.namedSpots ?? []), ...preferredSpots])];
  return { slots: seeded, used };
}

// Standing blackouts narrow this plan's window, so nobody is offered a slot they
// already told us never works.
function applyBlackouts(slots: Slots, blackouts: Blackout[] | undefined, day: Date): Slots {
  if (!blackouts?.length || !slots.window?.value) return slots;
  const clipped = clipWindow(slots.window.value, blackouts, day);
  return { ...slots, window: { ...slots.window, value: clipped } };
}

async function advanceOnboarding(
  existing: UserDoc | null,
  userId: string,
  raw: RawSlots,
  text: string,
): Promise<{ user: UserDoc; done: boolean }> {
  const user: UserDoc = existing
    ? { ...existing, profile: { ...existing.profile }, askedProfile: [...(existing.askedProfile ?? [])] }
    : blankUser(userId);
  const asked = user.askedProfile ?? [];

  // The first message is what created the plan, not an answer to anything.
  const answering = asked[asked.length - 1] as ProfileField | undefined;

  if (answering === "home") {
    const home = await resolveHome(raw.homeRaw ?? text);
    if (home.value) user.profile.home = home.value;
  } else if (answering === "dietary") {
    const { slot } = resolveDietary(raw.dietaryRaw ?? text);
    if (slot.value) user.profile.dietary = slot.value;
  } else if (answering === "blackouts") {
    user.profile.blackouts = resolveBlackouts(raw.blackoutRaw ?? text);
  } else if (answering === "preferredSpots") {
    // "none" here is an answer, not a favourite called none.
    const declined = /^(none|nope|no|nothing|na|n\/a|skip|not really|cant think of any)\b/i.test(text.trim());
    for (const name of declined ? [] : (raw.namedSpots ?? [text])) {
      const venue = findVenueByName(name);
      if (venue) user.profile.preferredSpots = [...new Set([...user.profile.preferredSpots, venue.id])];
      else user.profile.tastes = [...new Set([...user.profile.tastes, name.toLowerCase()])];
    }
  }

  const next = PROFILE_ORDER.find((field) => !asked.includes(field));
  if (next) {
    user.askedProfile = [...asked, next];
    return { user, done: false };
  }

  user.onboardedAt = new Date().toISOString();
  return { user, done: true };
}

// Incremental, so an abandoned plan still teaches us something. Budget and
// window are never promoted: both are occasion-specific.
async function writeBackProfile(
  store: Store,
  user: UserDoc,
  slots: Slots,
): Promise<void> {
  const next: UserDoc = { ...user, profile: { ...user.profile } };
  let changed = false;

  if (slots.home?.value && slots.home.confidence === "high") {
    if (next.profile.home?.label !== slots.home.value.label) {
      next.profile.home = slots.home.value;
      changed = true;
    }
  }
  // An empty array is a real answer ("I eat everything"), so it must persist.
  // Guarding on length > 0 left the old value in the profile forever.
  if (Array.isArray(slots.dietary?.value)) {
    if ((next.profile.dietary ?? []).join() !== slots.dietary.value.join()) {
      next.profile.dietary = slots.dietary.value;
      changed = true;
    }
  }
  const tastes = [...new Set([...next.profile.tastes, ...(slots.tags ?? [])])];
  if (tastes.length !== next.profile.tastes.length) {
    next.profile.tastes = tastes;
    changed = true;
  }
  const spots = [...new Set([...next.profile.preferredSpots, ...(slots.namedSpots ?? [])])];
  if (spots.length !== next.profile.preferredSpots.length) {
    next.profile.preferredSpots = spots;
    changed = true;
  }

  if (changed) await store.upsertUser(next);
}

// Contract 2. A resolves sender and plan, then calls this with the raw text.
export async function handleDM(
  input: HandleDMInput,
  store: Store,
  day: Date = new Date(),
): Promise<HandleDMResult> {
  const now = new Date().toISOString();

  // History is read BEFORE storing this message, so extraction sees what came
  // before rather than the current turn twice.
  const history = await store.listMessages(input.planId, input.userId);
  await store.appendMessage(input.planId, input.userId, {
    at: now,
    direction: "in",
    text: input.text,
  });

  const stored = await store.getUser(input.userId);
  const existing = await store.getSlots(input.planId, input.userId);

  async function reply(text: string, slots: Slots, missing: RequiredSlot[]): Promise<HandleDMResult> {
    await store.appendMessage(input.planId, input.userId, { at: now, direction: "out", text });
    return { slots, missing, reply: text };
  }

  let justOnboarded = false;
  if (!stored?.onboardedAt) {
    const rawProfile = await extract(input.text, {
      history,
      expecting: (stored?.askedProfile ?? []).slice(-1)[0] as "blackouts" | undefined,
    });
    const { user, done } = await advanceOnboarding(stored, input.userId, rawProfile, input.text);
    await store.upsertUser(user);
    if (!done) {
      const field = (user.askedProfile ?? []).slice(-1)[0] as ProfileField;
      return reply(PROFILE_QUESTIONS[field], existing, missingSlots(existing));
    }
    justOnboarded = true;
  }

  const user = await store.getUser(input.userId);
  const seeded = seedFromProfile(existing, user);

  // The message that completed onboarding was an answer to a PROFILE question.
  // Reading it again as a plan answer let "none" (answering "any favourite
  // places?") resolve as a dietary answer and wipe the dietary profile.
  if (justOnboarded) {
    await store.setSlots(input.planId, input.userId, seeded.slots);
    const missingNow = missingSlots(seeded.slots);
    const recallNow = seeded.used.length > 0 ? `Using ${seeded.used.join(" and ")} from your profile. ` : "";
    return reply(recallNow + nextQuestion(missingNow), seeded.slots, missingNow);
  }

  // What we asked last, so a bare "30" lands on the slot in question.
  const expecting = missingSlots(seeded.slots)[0];

  const raw = await extract(input.text, { history, expecting });
  let resolved = await resolveSlots(raw, seeded.slots, undefined, day);
  resolved = applyBlackouts(resolved, user?.profile.blackouts, day);

  await store.setSlots(input.planId, input.userId, resolved);
  if (user) await writeBackProfile(store, user, resolved);

  const missing = missingSlots(resolved);
  const question = nextQuestion(missing);
  const recall = seeded.used.length > 0 ? `Using ${seeded.used.join(" and ")} from your profile. ` : "";
  return reply(recall + question, resolved, missing);
}
