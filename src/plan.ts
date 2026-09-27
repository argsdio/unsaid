import { randomInt } from "node:crypto";
import type { PlanDoc, RequiredSlot, UserDoc } from "./contracts.ts";
import type { Store } from "./db.ts";
import { botLog, slotSnapshot } from "./log.ts";
import { forgetNessieOffer } from "./nessie.ts";
import { missingSlots } from "./slots.ts";
import { findVenueByName } from "./venues.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type SpaceRef = { spaceId: string; linePhone?: string };

const spaces = new Map<string, SpaceRef>();
const confirms = new Map<string, Set<string>>();
const lastCards = new Map<string, string>();

function spaceKey(planId: string, userId: string): string {
  return `${planId}:${userId}`;
}

export function parseJoin(text: string): string | null {
  const match = text.trim().match(/^JOIN\s+([A-Za-z0-9]{4})$/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

export function forgetSpaces(planId: string): void {
  for (const key of [...spaces.keys()]) {
    if (key.startsWith(`${planId}:`)) spaces.delete(key);
  }
  confirms.delete(planId);
  lastCards.delete(planId);
}

export function rememberCard(planId: string, text: string): void {
  lastCards.set(planId, text);
  confirms.set(planId, new Set());
}

export function cardFor(planId: string): string | undefined {
  return lastCards.get(planId);
}

export function markConfirm(planId: string, userId: string): { first: boolean; have: number } {
  let set = confirms.get(planId);
  if (!set) {
    set = new Set();
    confirms.set(planId, set);
  }
  const first = !set.has(userId);
  set.add(userId);
  return { first, have: set.size };
}

export function waitingIds(plan: PlanDoc): string[] {
  const set = confirms.get(plan._id) ?? new Set();
  return plan.participants.filter((id) => !set.has(id));
}

export function isConfirmEmoji(emoji: string): boolean {
  return /👍|❤️|❤|😍|✅|😂|‼️|💯/.test(emoji) && !emoji.includes("👎");
}

export function parseConfirmText(text: string): boolean {
  const trimmed = text.trim();
  if (/^(yes|yep|yeah|ok|okay|works|confirm|👍|❤️)$/i.test(trimmed)) return true;
  return /^(Liked|Loved|Laughed at|Emphasized)\b/i.test(trimmed);
}

export function parseLeave(text: string): boolean {
  return /^(reset|leave|new plan|abandon|start over)\b/i.test(text.trim());
}

export function parseForgetMe(text: string): boolean {
  return /^\s*forget me\s*$/i.test(text);
}

export function forgetUserSpaces(userId: string): void {
  const suffix = `:${userId}`;
  for (const key of [...spaces.keys()]) {
    if (key.endsWith(suffix)) spaces.delete(key);
  }
  for (const set of confirms.values()) set.delete(userId);
}

export function parseGo(text: string): boolean {
  return /^\s*(@unsaid\s+)?go\s*$/i.test(text);
}

export function parseAddFavorite(text: string): string | null {
  const trimmed = text.trim();
  const labeled = trimmed.match(
    /^(?:i (?:want|would like|'d like) to )?add (?:this )?(?:place|spot|restaurant) to my (?:preferences|favourites|favorites):\s*(.+)$/i,
  );
  if (labeled?.[1]?.trim()) return labeled[1].trim();
  const toMy = trimmed.match(/^add\s+(.+?)\s+to my (?:preferences|favourites|favorites)\s*$/i);
  if (toMy?.[1]?.trim()) return toMy[1].trim();
  return null;
}

function mintCode(): string {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function spaceRef(space: { id: string; phone?: string }): SpaceRef {
  const ref: SpaceRef = { spaceId: space.id };
  if (space.phone) ref.linePhone = space.phone;
  return ref;
}

export function rememberSpace(
  planId: string,
  userId: string,
  space: { id: string; phone?: string },
): void {
  spaces.set(spaceKey(planId, userId), spaceRef(space));
}

export function spacesFor(plan: PlanDoc): Record<string, SpaceRef> {
  const out: Record<string, SpaceRef> = {};
  for (const userId of plan.participants) {
    const ref = spaces.get(spaceKey(plan._id, userId));
    if (ref) out[userId] = ref;
  }
  return out;
}

export function isHost(plan: PlanDoc, userId: string): boolean {
  return plan.participants[0] === userId;
}

export async function createPlan(
  store: Store,
  creatorId: string,
  space: { id: string; phone?: string },
): Promise<PlanDoc> {
  for (let i = 0; i < 20; i++) {
    const joinCode = mintCode();
    const plan: PlanDoc = {
      _id: crypto.randomUUID(),
      joinCode,
      participants: [creatorId],
      status: "collecting",
      slots: {},
    };
    const ok = await store.createPlan(plan);
    if (!ok) continue;
    await store.setActivePlan(creatorId, plan._id);
    rememberSpace(plan._id, creatorId, space);
    return plan;
  }
  throw new Error("could not mint a unique join code");
}

export async function joinPlan(
  store: Store,
  userId: string,
  code: string,
  space: { id: string; phone?: string },
): Promise<{ plan: PlanDoc } | { error: string }> {
  const plan = await store.getPlanByJoinCode(code.trim().toUpperCase());
  if (!plan) {
    return { error: `No live plan uses JOIN ${code.trim().toUpperCase()}. Ask the host for a new code.` };
  }
  await store.addParticipant(plan._id, userId);
  await store.setActivePlan(userId, plan._id);
  rememberSpace(plan._id, userId, space);
  const latest = (await store.getPlan(plan._id)) ?? plan;
  return { plan: latest };
}

export async function activePlan(store: Store, userId: string): Promise<PlanDoc | null> {
  const user = await store.getUser(userId);
  if (!user?.activePlanId) return null;
  return store.getPlan(user.activePlanId);
}

export type GoReadiness = {
  userId: string;
  missing: RequiredSlot[];
  slots: Record<string, unknown>;
};

// Same check onGo uses: stored plan slots only, no profile re-seed. A person
// who texted but never JOIN'd is not in participants and cannot block go.
export async function goReadiness(store: Store, plan: PlanDoc): Promise<GoReadiness[]> {
  const rows: GoReadiness[] = [];
  for (const userId of plan.participants) {
    const slots = await store.getSlots(plan._id, userId);
    rows.push({ userId, missing: missingSlots(slots), slots: slotSnapshot(slots) });
  }
  return rows;
}

export function goBlockers(rows: GoReadiness[]): GoReadiness[] {
  return rows.filter((row) => row.missing.length > 0);
}

export function logGoReadiness(rows: GoReadiness[]): void {
  for (const row of rows) {
    botLog("go: readiness", {
      userId: row.userId,
      missing: row.missing.length ? row.missing : "(none)",
      ...row.slots,
    });
  }
}

export async function abandonPlan(
  store: Store,
  userId: string,
): Promise<{ message: string; notify: PlanDoc | null }> {
  const plan = await activePlan(store, userId);
  if (!plan) {
    return { message: "You're not on a plan.", notify: null };
  }

  if (isHost(plan, userId)) {
    for (const participant of plan.participants) {
      await store.clearActivePlan(participant);
    }
    await store.setStatus(plan._id, "confirmed");
    await store.deletePlan(plan._id);
    return {
      message: "Plan cleared. Text dinner plans to start a new one, or JOIN a new code.",
      notify: plan,
    };
  }

  await store.clearActivePlan(userId);
  return {
    message: "You've left the plan. Text dinner plans to host, or JOIN a code.",
    notify: null,
  };
}

export async function forgetUser(store: Store, userId: string): Promise<string> {
  const plan = await activePlan(store, userId);
  if (plan) await store.setSlots(plan._id, userId, {});
  await store.deleteUser(userId);
  forgetUserSpaces(userId);
  forgetNessieOffer(userId);
  botLog("forget me", { userId, planId: plan?._id });
  return plan
    ? "Forgotten — next text is first-time setup. This plan still lists you until the host sends reset."
    : "Forgotten — next text is first-time setup.";
}

export async function saveFavorite(store: Store, userId: string, place: string): Promise<string> {
  const venue = findVenueByName(place);
  const existing = await store.getUser(userId);
  const user: UserDoc = existing
    ? { ...existing, profile: { ...existing.profile } }
    : {
        _id: userId,
        phone: userId,
        profile: { tastes: [], preferredSpots: [] },
        askedProfile: [],
        wishlist: [],
      };

  if (venue) {
    user.profile.preferredSpots = [...new Set([...user.profile.preferredSpots, venue.id])];
    await store.upsertUser(user);
    return `Saved ${venue.name} to your favorites. I'll weigh it when we pick a place.`;
  }

  const label = place.replace(/^https?:\/\//i, "").slice(0, 80);
  user.profile.tastes = [...new Set([...user.profile.tastes, label.toLowerCase()])];
  await store.upsertUser(user);
  return `I don't have that exact spot in the list, but I noted “${label}” as a taste. Keep answering the last question when you're ready.`;
}

export function shareText(joinCode: string): string {
  return [
    `You're the host. Paste this in your group chat (Unsaid is not in that chat):`,
    "",
    `Text your Unsaid: JOIN ${joinCode}`,
  ].join("\n");
}
