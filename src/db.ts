import { type Collection, MongoClient } from "mongodb";
import type {
  Occasion,
  PlanDoc,
  PlanStatus,
  RoundLog,
  SavedNegotiation,
  Slots,
  StoredMessage,
  UserDoc,
} from "./contracts.ts";

// A join code only resolves while the plan is live, so codes become reusable
// across demo re-runs and a stale code cannot pull someone into a finished plan.
const ACTIVE: PlanStatus[] = ["collecting", "negotiating", "proposed"];

export type Store = {
  // Plans. A owns joinCode, participants and status; B owns slots.
  createPlan(plan: PlanDoc): Promise<boolean>;
  getPlan(planId: string): Promise<PlanDoc | null>;
  getPlanByJoinCode(code: string): Promise<PlanDoc | null>;
  addParticipant(planId: string, userId: string): Promise<void>;
  setStatus(planId: string, status: PlanStatus): Promise<void>;
  setPlanDate(planId: string, date: string): Promise<void>;
  setOccasion(planId: string, occasion: Occasion): Promise<void>;
  setShortlist(planId: string, venueIds: string[]): Promise<void>;
  // One vote per person; voting again replaces the previous choice.
  recordVote(planId: string, userId: string, venueId: string): Promise<void>;
  // Un-tapping an option on a native poll removes the vote entirely, which is
  // different from changing it -- the person is back to undecided.
  removeVote(planId: string, userId: string): Promise<void>;
  // Full teardown: the plan, its rounds and its messages. Used to reset between
  // demo runs, and so tests can clean up after themselves against a real cluster.
  deletePlan(planId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  // Leaving a plan must drop the person's slots as well as their membership.
  // Membership alone kept `go` waiting on them forever, and their stale slots
  // still fed mergeConstraints.
  removeParticipant(planId: string, userId: string): Promise<void>;

  getSlots(planId: string, userId: string): Promise<Slots>;
  getAllSlots(planId: string): Promise<Record<string, Slots>>;
  setSlots(planId: string, userId: string, slots: Slots): Promise<void>;

  appendMessage(planId: string, userId: string, message: StoredMessage): Promise<void>;
  listMessages(planId: string, userId: string): Promise<StoredMessage[]>;

  getUser(userId: string): Promise<UserDoc | null>;
  // A calls this on join. Never upsertUser, which replaces the whole document
  // and would wipe the profile and onboarding state that B builds.
  setActivePlan(userId: string, planId: string): Promise<void>;
  // Narrow write so callers never reach for upsertUser to save one field.
  addFavorite(userId: string, venueId: string): Promise<void>;
  clearActivePlan(userId: string): Promise<void>;
  upsertUser(user: UserDoc): Promise<void>;

  appendRound(round: RoundLog): Promise<void>;
  listRounds(planId: string): Promise<RoundLog[]>;

  // A negotiation paused on a human. Persisted rather than held in memory so it
  // survives both the minutes someone takes to reply and a process restart.
  saveNegotiation(state: SavedNegotiation): Promise<void>;
  getNegotiation(planId: string): Promise<SavedNegotiation | null>;
  clearNegotiation(planId: string): Promise<void>;

  close(): Promise<void>;
};

function blankPlan(planId: string): PlanDoc {
  return { _id: planId, joinCode: "", participants: [], status: "collecting", slots: {} };
}

// Without MONGODB_URI everything runs in memory, so the harness and the backroom
// screen do not wait on an Atlas cluster. State does not survive a restart.
function memoryStore(): Store {
  const plans = new Map<string, PlanDoc>();
  const users = new Map<string, UserDoc>();
  const rounds: RoundLog[] = [];
  const messages = new Map<string, StoredMessage[]>();
  const negotiations = new Map<string, SavedNegotiation>();

  function findByCode(code: string): PlanDoc | null {
    if (!code.trim()) return null;
    for (const plan of plans.values()) {
      if (plan.joinCode === code && ACTIVE.includes(plan.status)) return plan;
    }
    return null;
  }

  function ensure(planId: string): PlanDoc {
    const existing = plans.get(planId);
    if (existing) return existing;
    const fresh = blankPlan(planId);
    plans.set(planId, fresh);
    return fresh;
  }

  return {
    async createPlan(plan) {
      if (plans.has(plan._id) || findByCode(plan.joinCode)) return false;
      plans.set(plan._id, { ...plan });
      return true;
    },
    async getPlan(planId) {
      return plans.get(planId) ?? null;
    },
    async getPlanByJoinCode(code) {
      return findByCode(code);
    },
    async addParticipant(planId, userId) {
      const plan = ensure(planId);
      if (!plan.participants.includes(userId)) plan.participants.push(userId);
    },
    async setStatus(planId, status) {
      ensure(planId).status = status;
    },
    async setPlanDate(planId, date) {
      ensure(planId).date = date;
    },
    async setOccasion(planId, occasion) {
      ensure(planId).occasion = occasion;
    },
    async setShortlist(planId, venueIds) {
      ensure(planId).shortlist = [...venueIds];
    },
    async recordVote(planId, userId, venueId) {
      const plan = ensure(planId);
      plan.votes = { ...(plan.votes ?? {}), [userId]: venueId };
    },
    async removeVote(planId, userId) {
      const plan = plans.get(planId);
      if (!plan?.votes) return;
      const { [userId]: _gone, ...rest } = plan.votes;
      plans.set(planId, { ...plan, votes: rest });
    },
    async deletePlan(planId) {
      plans.delete(planId);
      for (let i = rounds.length - 1; i >= 0; i--) {
        if (rounds[i]?.planId === planId) rounds.splice(i, 1);
      }
      for (const key of [...messages.keys()]) {
        if (key.startsWith(`${planId}:`)) messages.delete(key);
      }
      negotiations.delete(planId);
    },
    async deleteUser(userId) {
      users.delete(userId);
    },
    async removeParticipant(planId, userId) {
      const plan = plans.get(planId);
      if (!plan) return;
      const { [userId]: _dropped, ...rest } = plan.slots;
      plans.set(planId, {
        ...plan,
        participants: plan.participants.filter((id) => id !== userId),
        slots: rest,
      });
    },
    async getSlots(planId, userId) {
      return plans.get(planId)?.slots[userId] ?? {};
    },
    async getAllSlots(planId) {
      return plans.get(planId)?.slots ?? {};
    },
    async setSlots(planId, userId, value) {
      ensure(planId).slots[userId] = value;
    },
    async appendMessage(planId, userId, message) {
      const key = `${planId}:${userId}`;
      messages.set(key, [...(messages.get(key) ?? []), message]);
    },
    async listMessages(planId, userId) {
      return messages.get(`${planId}:${userId}`) ?? [];
    },
    async getUser(userId) {
      return users.get(userId) ?? null;
    },
    async setActivePlan(userId, planId) {
      const existing = users.get(userId);
      users.set(userId, existing
        ? { ...existing, activePlanId: planId }
        : { _id: userId, phone: userId, profile: { tastes: [], preferredSpots: [] }, wishlist: [], activePlanId: planId });
    },
    async clearActivePlan(userId) {
      const existing = users.get(userId);
      if (!existing) return;
      users.set(userId, { ...existing, activePlanId: undefined });
    },
    async addFavorite(userId, venueId) {
      const existing = users.get(userId);
      const base = existing ?? {
        _id: userId, phone: userId,
        profile: { tastes: [], preferredSpots: [] }, wishlist: [],
      };
      users.set(userId, {
        ...base,
        profile: {
          ...base.profile,
          preferredSpots: [...new Set([...base.profile.preferredSpots, venueId])],
        },
      });
    },
    // Merges, matching the Mongo implementation's $set semantics. Replacing the
    // document here meant a caller who omitted activePlanId silently dropped it,
    // so the same call behaved differently depending on which store was running.
    async upsertUser(user) {
      const existing = users.get(user._id);
      users.set(user._id, existing ? { ...existing, ...user } : user);
    },
    async appendRound(round) {
      rounds.push(round);
    },
    async listRounds(planId) {
      return rounds.filter((r) => r.planId === planId).sort((a, b) => a.round - b.round);
    },
    async saveNegotiation(state) {
      negotiations.set(state.planId, state);
    },
    async getNegotiation(planId) {
      return negotiations.get(planId) ?? null;
    },
    async clearNegotiation(planId) {
      negotiations.delete(planId);
    },
    async close() {},
  };
}

// Fields to seed when an update upserts a plan into existence. Whatever the
// update itself touches must be omitted, or Mongo rejects the write with a path
// conflict -- and omitting the rest would leave a PlanDoc missing required fields.
function seedExcept(planId: string, omit: string[]): Record<string, unknown> {
  const blank: Record<string, unknown> = { ...blankPlan(planId) };
  delete blank._id;
  for (const key of omit) delete blank[key];
  return blank;
}

async function mongoStore(uri: string): Promise<Store> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "unsaid");
  const plans: Collection<PlanDoc> = db.collection<PlanDoc>("plans");
  const users = db.collection<UserDoc>("users");
  const rounds = db.collection<RoundLog>("rounds");
  const messages = db.collection<StoredMessage & { planId: string; userId: string }>("messages");
  const negotiations = db.collection<SavedNegotiation>("negotiations");

  async function findByCode(code: string): Promise<PlanDoc | null> {
    if (!code.trim()) return null;
    return plans.findOne({ joinCode: code, status: { $in: ACTIVE } });
  }

  return {
    async createPlan(plan) {
      if (await findByCode(plan.joinCode)) return false;
      try {
        await plans.insertOne(plan);
        return true;
      } catch {
        // Duplicate _id: the plan already exists.
        return false;
      }
    },
    async getPlan(planId) {
      return plans.findOne({ _id: planId });
    },
    async getPlanByJoinCode(code) {
      return findByCode(code);
    },
    async addParticipant(planId, userId) {
      await plans.updateOne(
        { _id: planId },
        {
          $addToSet: { participants: userId },
          $setOnInsert: seedExcept(planId, ["participants"]),
        },
        { upsert: true },
      );
    },
    async setStatus(planId, status) {
      await plans.updateOne(
        { _id: planId },
        { $set: { status }, $setOnInsert: seedExcept(planId, ["status"]) },
        { upsert: true },
      );
    },
    async setPlanDate(planId, date) {
      await plans.updateOne({ _id: planId }, { $set: { date } });
    },
    async setOccasion(planId, occasion) {
      await plans.updateOne({ _id: planId }, { $set: { occasion } });
    },
    async setShortlist(planId, venueIds) {
      await plans.updateOne({ _id: planId }, { $set: { shortlist: venueIds } });
    },
    async recordVote(planId, userId, venueId) {
      await plans.updateOne({ _id: planId }, { $set: { [`votes.${userId}`]: venueId } });
    },
    async removeVote(planId, userId) {
      await plans.updateOne({ _id: planId }, { $unset: { [`votes.${userId}`]: "" } });
    },
    async deletePlan(planId) {
      await Promise.all([
        plans.deleteOne({ _id: planId }),
        rounds.deleteMany({ planId }),
        messages.deleteMany({ planId }),
        negotiations.deleteMany({ planId }),
      ]);
    },
    async deleteUser(userId) {
      await users.deleteOne({ _id: userId });
    },
    async removeParticipant(planId, userId) {
      await plans.updateOne(
        { _id: planId },
        { $pull: { participants: userId }, $unset: { [`slots.${userId}`]: "" } },
      );
    },
    async getSlots(planId, userId) {
      const plan = await plans.findOne({ _id: planId });
      return plan?.slots?.[userId] ?? {};
    },
    async getAllSlots(planId) {
      const plan = await plans.findOne({ _id: planId });
      return plan?.slots ?? {};
    },
    // Touches only this user's key, so A's writes to participants and status survive.
    async setSlots(planId, userId, value) {
      await plans.updateOne(
        { _id: planId },
        {
          $set: { [`slots.${userId}`]: value },
          $setOnInsert: seedExcept(planId, ["slots"]),
        },
        { upsert: true },
      );
    },
    async appendMessage(planId, userId, message) {
      await messages.insertOne({ ...message, planId, userId });
    },
    async listMessages(planId, userId) {
      const rows = await messages.find({ planId, userId }).sort({ at: 1 }).toArray();
      return rows.map(({ at, direction, text }) => ({ at, direction, text }));
    },
    async getUser(userId) {
      return users.findOne({ _id: userId });
    },
    async setActivePlan(userId, planId) {
      await users.updateOne(
        { _id: userId },
        {
          $set: { activePlanId: planId },
          $setOnInsert: { phone: userId, profile: { tastes: [], preferredSpots: [] }, wishlist: [] },
        },
        { upsert: true },
      );
    },
    async clearActivePlan(userId) {
      await users.updateOne({ _id: userId }, { $unset: { activePlanId: "" } });
    },
    async addFavorite(userId, venueId) {
      await users.updateOne(
        { _id: userId },
        {
          $addToSet: { "profile.preferredSpots": venueId },
          $setOnInsert: { phone: userId, wishlist: [] },
        },
        { upsert: true },
      );
    },
    async upsertUser(user) {
      const { _id, ...rest } = user;
      await users.updateOne({ _id }, { $set: rest }, { upsert: true });
    },
    async appendRound(round) {
      await rounds.insertOne(round);
    },
    async listRounds(planId) {
      return rounds.find({ planId }).sort({ round: 1 }).toArray();
    },
    async saveNegotiation(state) {
      await negotiations.replaceOne({ planId: state.planId }, state, { upsert: true });
    },
    async getNegotiation(planId) {
      return negotiations.findOne({ planId });
    },
    async clearNegotiation(planId) {
      await negotiations.deleteOne({ planId });
    },
    async close() {
      await client.close();
    },
  };
}

// `memory: true` forces the in-memory store even when MONGODB_URI is set, so
// tests of store behaviour stay deterministic and idempotent.
export async function openStore(opts: { memory?: boolean } = {}): Promise<Store> {
  const uri = process.env.MONGODB_URI;
  return uri && !opts.memory ? mongoStore(uri) : memoryStore();
}
