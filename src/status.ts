import type { RequiredSlot } from "./contracts.ts";
import { hasOverlap, mergeConstraints } from "./aggregator.ts";
import { travelProfiles } from "./aggregator.ts";
import type { Store } from "./db.ts";
import { missingSlots } from "./slots.ts";
import { VENUES, filterVenues, venueById } from "./venues.ts";

export function parseStatus(text: string): boolean {
  return /^\s*(@unsaid\s+)?(status|where are we|whats going on|what's going on|who's left|whos left|debug)\s*\??\s*$/i.test(
    text,
  );
}

// Short human labels: a DM should not name internal slot keys.
const LABEL: Record<RequiredSlot, string> = {
  home: "where from",
  window: "time",
  maxTravelMin: "how far",
  dietary: "food",
  budgetCapUSD: "budget",
};

// userId is the phone handle, so the last four digits are how people actually
// identify each other. Short non-numeric ids (tests, fixtures) print in full.
function shortName(userId: string): string {
  const digits = userId.replace(/\D/g, "");
  return digits.length >= 4 ? `···${digits.slice(-4)}` : userId;
}

function clock(iso: string): string {
  const [h, m] = iso.slice(11, 16).split(":").map(Number);
  const hour = ((h ?? 0) % 12) || 12;
  const suffix = (h ?? 0) < 12 ? "am" : "pm";
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

// Everything here is either group-level or the caller's own. Other people's
// answers are reported only as which field is outstanding, never its value.
export async function planStatus(
  store: Store,
  planId: string | undefined,
  userId: string,
): Promise<string> {
  const user = await store.getUser(userId);
  const profile = user?.profile;
  const own = profile
    ? [
        profile.home?.label,
        profile.dietary?.length ? profile.dietary.join(", ") : "eats everything",
        profile.blackouts?.length ? `${profile.blackouts.length} blackout time(s)` : "no blackout times",
        profile.preferredSpots.length ? `${profile.preferredSpots.length} saved spot(s)` : "no saved spots",
      ]
        .filter(Boolean)
        .join(" · ")
    : "not set up yet";

  if (!planId) {
    return `You're not in a plan right now. Text me to start one, or send JOIN <code> to join a friend's.\n\nYour profile: ${own}`;
  }

  const plan = await store.getPlan(planId);
  if (!plan) return `I can't find that plan any more.\n\nYour profile: ${own}`;

  const slots = await store.getAllSlots(planId);
  const lines: string[] = [`Plan ${plan.joinCode} · ${plan.status} · ${plan.participants.length} joined`];

  const people = plan.participants.map((id) => ({ userId: id, slots: slots[id] ?? {} }));
  const roster = people.map((p) => {
    const missing = missingSlots(p.slots);
    const who = p.userId === userId ? "you" : shortName(p.userId);
    return missing.length === 0
      ? `  ${who}: ready`
      : `  ${who}: waiting on ${missing.map((m) => LABEL[m]).join(", ")}`;
  });
  lines.push("", ...roster);

  const answered = people.filter((p) => missingSlots(p.slots).length === 0);
  if (answered.length > 0) {
    const merged = mergeConstraints(answered);
    const diet = merged.requiredDietary.length ? merged.requiredDietary.join(", ") : "anything";
    const when = hasOverlap(merged.window)
      ? `${clock(merged.window.start)}–${clock(merged.window.end)}`
      : "NO shared time yet";
    // Only people who finished contribute, so say so -- the number moves as the
    // rest answer, and a partial cap read as final is misleading while debugging.
    const scope =
      answered.length === people.length ? "Group" : `Group so far (${answered.length} of ${people.length} answered)`;
    lines.push("", `${scope}: under $${merged.budgetCapUSD} · ${diet} · ${when}`);

    const { survivors } = filterVenues(VENUES, merged, travelProfiles(answered));
    lines.push(
      survivors.length > 0
        ? `${survivors.length} of ${VENUES.length} places still fit${
            survivors[0] ? ` (e.g. ${venueById(survivors[0].venueId)?.name})` : ""
          }`
        : `Nothing fits yet — someone would need to flex`,
    );
  }

  if (plan.chosen) {
    lines.push("", `Picked: ${venueById(plan.chosen.venueId)?.name} at ${clock(plan.chosen.time)}`);
  }

  lines.push("", `Your profile: ${own}`);
  return lines.join("\n");
}
