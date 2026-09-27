import type {
  Blackout,
  Occasion,
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
import { type Geocoder, resolveHome } from "./resolve/location.ts";
import { clipWindow, defaultWindow, describeWindow } from "./resolve/time.ts";
import { BOROUGHS } from "./resolve/gazetteer.ts";
import { classifyMeta, metaReply } from "./meta.ts";
import { grokGeocoder } from "./resolve/geocode.ts";
import { findVenueByName } from "./venues.ts";

const MANHATTAN = BOROUGHS.manhattan ?? { lat: 40.7831, lng: -73.9712 };

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
  home: "Where are you coming from? A neighborhood, a landmark or an address.",
  window: "What time works for you? Something like \"after 7\" or \"6 to 10\".",
  maxTravelMin: "How far are you up for travelling? e.g. \"30 min\" or \"not far\".",
  dietary: "Anything I should plan around food-wise? \"I eat everything\" is a fine answer.",
  budgetCapUSD: "Last thing — roughly what are you thinking budget-wise? \"cheap\" works too.",
};

// The retry asks for something EASIER, not the same thing with more formats.
// Listing formats invites two failures: an example that resembles what the person
// just typed reads as "you wrote it wrong", and promising cross-streets or
// addresses depends on the geocoder being reachable. A neighborhood always works,
// because the gazetteer handles it with no network at all.
//
// Capitalisation and punctuation never matter anywhere -- normalise() lowercases
// and strips before any resolver sees the text.
const RETRY: Record<RequiredSlot, string> = {
  home: "Hmm, I couldn't place that. What neighborhood is it in? Bushwick, Harlem, the East Village — that kind of thing.",
  window: "Sorry, what time roughly? Just an hour is fine — 7, or 8.",
  maxTravelMin: "Roughly how many minutes are you willing to travel? A number is fine.",
  dietary: "Anything you can't eat? If there's nothing, just say none.",
  budgetCapUSD: "Roughly how many dollars per person? A number is fine.",
};

// After this many asks, assume something and move on. A slot we cannot read must
// degrade to a low-confidence default, never block the plan.
const MAX_ASKS = 2;

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

// Echo back what this message filled. Cheap, and it makes a misread visible in
// the very next turn instead of at `go` -- a budget silently set to $30 by a
// mangled time would have been caught here immediately.
function acknowledge(before: Slots, after: Slots): string {
  const got: string[] = [];
  if (!before.home?.value && after.home?.value) got.push(after.home.value.label);
  if (!before.window?.value && after.window?.value) {
    got.push(describeWindow(after.window.raw, after.window.value));
  }
  if (before.maxTravelMin?.value == null && after.maxTravelMin?.value != null) {
    got.push(`up to ${after.maxTravelMin.value} min`);
  }
  if (!before.dietary?.value && after.dietary?.value) {
    got.push(after.dietary.value.length ? after.dietary.value.join(", ") : "no food limits");
  }
  if (before.budgetCapUSD?.value == null && after.budgetCapUSD?.value != null) {
    got.push(`$${after.budgetCapUSD.value}`);
  }
  return got.length ? `${got.join(", ")} \u2014 got it. ` : "";
}

// What to assume when a slot cannot be read. Always low confidence, and always
// announced, so the person can correct it.
function assumeDefault(
  slots: Slots,
  slot: RequiredSlot,
  day: Date,
  occasion: Occasion,
): { slots: Slots; note: string } {
  const next: Slots = { ...slots };
  switch (slot) {
    case "home":
      next.home = { raw: "(assumed)", value: { ...MANHATTAN, label: "Manhattan" }, confidence: "low" };
      return { slots: next, note: "I'll start you from Manhattan for now" };
    case "window":
      next.window = { raw: "(assumed)", value: defaultWindow(day, occasion), confidence: "low" };
      return { slots: next, note: "I'll assume you're free this evening" };
    case "maxTravelMin":
      next.maxTravelMin = { raw: "(assumed)", value: 45, confidence: "low" };
      return { slots: next, note: "I'll assume up to 45 minutes of travel" };
    case "dietary":
      next.dietary = { raw: "(assumed)", value: [], confidence: "low" };
      return { slots: next, note: "I'll assume no food restrictions" };
    case "budgetCapUSD":
      next.budgetCapUSD = { raw: "(assumed)", value: 35, confidence: "low" };
      return { slots: next, note: "I'll assume around $35" };
  }
}

// Increments the ask count for whatever is next, rephrases on the second ask,
// and assumes a default past MAX_ASKS so the conversation always advances.
function advance(
  slots: Slots,
  day: Date,
  occasion: Occasion,
): { slots: Slots; reply: string; complete?: true } {
  let next = slots;
  const notes: string[] = [];

  for (let guard = 0; guard < REQUIRED_SLOTS.length + 1; guard++) {
    const missing = missingSlots(next);
    const slot = missing[0];
    if (!slot) break;

    const asks = (next.attempts?.[slot] ?? 0) + 1;
    next = { ...next, attempts: { ...(next.attempts ?? {}), [slot]: asks } };

    if (asks > MAX_ASKS) {
      const assumed = assumeDefault(next, slot, day, occasion);
      next = assumed.slots;
      notes.push(assumed.note);
      continue;
    }

    const question = asks >= 2 ? RETRY[slot] : QUESTIONS[slot];
    const prefix = notes.length ? `${notes.join(", and ")} \u2014 say so any time if that's wrong. ` : "";
    return { slots: next, reply: prefix + question };
  }

  const prefix = notes.length ? `${notes.join(", and ")}. ` : "";
  return { slots: next, reply: prefix + DONE, complete: true };
}

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
  geocode?: Geocoder,
): Promise<{ user: UserDoc; done: boolean }> {
  const user: UserDoc = existing
    ? { ...existing, profile: { ...existing.profile }, askedProfile: [...(existing.askedProfile ?? [])] }
    : blankUser(userId);
  const asked = user.askedProfile ?? [];

  // The first message is what created the plan, not an answer to anything.
  const answering = asked[asked.length - 1] as ProfileField | undefined;

  if (answering === "home") {
    const home = await resolveHome(raw.homeRaw ?? text, geocode);
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
  dayOverride?: Date,
): Promise<HandleDMResult> {
  const now = new Date().toISOString();
  const geocode = grokGeocoder();

  // Times and blackouts resolve against the day the plan is FOR, not today.
  // "after 7" on a Wednesday for a Friday plan means Friday at 7.
  const planDoc = await store.getPlan(input.planId);
  const day = dayOverride ?? (planDoc?.date ? new Date(`${planDoc.date}T12:00:00`) : new Date());
  const occasion = planDoc?.occasion ?? "dinner";

  // History is read BEFORE storing this message, so extraction sees what came
  // before rather than the current turn twice.
  const history = await store.listMessages(input.planId, input.userId);
  await store.appendMessage(input.planId, input.userId, {
    at: now,
    direction: "in",
    text: input.text,
  });

  async function reply(text: string, slots: Slots, missing: RequiredSlot[]): Promise<HandleDMResult> {
    await store.appendMessage(input.planId, input.userId, { at: now, direction: "out", text });
    return { slots, missing, reply: text };
  }

  const stored = await store.getUser(input.userId);
  const existing = await store.getSlots(input.planId, input.userId);

  // A question is not an answer. Handled before anything reads it as one, so an
  // aside never burns a retry or triggers an assumed default.
  const meta = classifyMeta(input.text);
  if (meta) {
    const pending = stored?.onboardedAt
      ? missingSlots(seedFromProfile(existing, stored).slots)[0]
      : undefined;
    // Seeded on the number of EXCHANGES, not stored messages: history grows by two
    // per turn, so seeding on its length gave an always-even number and a
    // two-variant rotation never alternated.
    return reply(metaReply(meta, pending, Math.floor(history.length / 2)), existing, missingSlots(existing));
  }

  let justOnboarded = false;
  if (!stored?.onboardedAt) {
    const rawProfile = await extract(input.text, {
      history,
      geocode,
      expecting: (stored?.askedProfile ?? []).slice(-1)[0] as "blackouts" | undefined,
    });
    const { user, done } = await advanceOnboarding(stored, input.userId, rawProfile, input.text, geocode);
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
    const stepped = advance(seeded.slots, day, occasion);
    await store.setSlots(input.planId, input.userId, stepped.slots);
    const recallNow = seeded.used.length > 0 ? `Using ${seeded.used.join(" and ")} from your profile. ` : "";
    return reply(recallNow + stepped.reply, stepped.slots, missingSlots(stepped.slots));
  }

  // What we asked last, so a bare "30" lands on the slot in question.
  const expecting = missingSlots(seeded.slots)[0];

  const raw = await extract(input.text, { history, expecting, geocode });
  let resolved = await resolveSlots(raw, seeded.slots, geocode, day, occasion);
  resolved = applyBlackouts(resolved, user?.profile.blackouts, day);

  const heard = acknowledge(seeded.slots, resolved);
  const stepped = advance(resolved, day, occasion);
  resolved = stepped.slots;

  await store.setSlots(input.planId, input.userId, resolved);
  if (user) await writeBackProfile(store, user, resolved);

  // "Got everything I need" was the answer to every later message, forever, and
  // after a failed `go` it was also untrue -- nothing was being worked out. Once
  // this person is done, say what is actually outstanding.
  let closing = stepped.reply;
  if (stepped.complete && planDoc) {
    const others = planDoc.participants.filter((id) => id !== input.userId);
    let waiting = 0;
    for (const other of others) {
      if (missingSlots(await store.getSlots(input.planId, other)).length > 0) waiting += 1;
    }
    const seed = Math.floor(history.length / 2);
    closing =
      waiting > 0
        ? [
            `You're all set. Waiting on ${waiting} more.`,
            `Nothing else from you — ${waiting} still to answer.`,
          ][seed % 2]!
        : [
            `Everyone's answered. Whoever started it can send "go".`,
            `All in. Send "go" when you're ready, or "status" to see the group's limits.`,
          ][seed % 2]!;
  }

  const recall = seeded.used.length > 0 ? `Using ${seeded.used.join(" and ")} from your profile. ` : "";
  return reply(recall + heard + closing, resolved, missingSlots(resolved));
}
