import { type Collection, MongoClient } from "mongodb";
import type { PlanDoc, PlanStatus, RoundLog, Slots, StoredMessage, UserDoc } from "./contracts.ts";

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

  getSlots(planId: string, userId: string): Promise<Slots>;
  getAllSlots(planId: string): Promise<Record<string, Slots>>;
  setSlots(planId: string, userId: string, slots: Slots): Promise<void>;

  appendMessage(planId: string, userId: string, message: StoredMessage): Promise<void>;
  listMessages(planId: string, userId: string): Promise<StoredMessage[]>;

  getUser(userId: string): Promise<UserDoc | null>;
  upsertUser(user: UserDoc): Promise<void>;

  appendRound(round: RoundLog): Promise<void>;
  listRounds(planId: string): Promise<RoundLog[]>;

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
    async upsertUser(user) {
      users.set(user._id, user);
    },
    async appendRound(round) {
      rounds.push(round);
    },
    async listRounds(planId) {
      return rounds.filter((r) => r.planId === planId).sort((a, b) => a.round - b.round);
    },
    async close() {},
  };
}

async function mongoStore(uri: string): Promise<Store> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB ?? "unsaid");
  const plans: Collection<PlanDoc> = db.collection<PlanDoc>("plans");
  const users = db.collection<UserDoc>("users");
  const rounds = db.collection<RoundLog>("rounds");
  const messages = db.collection<StoredMessage & { planId: string; userId: string }>("messages");

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
        { $addToSet: { participants: userId }, $setOnInsert: blankPlan(planId) },
        { upsert: true },
      );
    },
    async setStatus(planId, status) {
      await plans.updateOne({ _id: planId }, { $set: { status } }, { upsert: true });
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
        { $set: { [`slots.${userId}`]: value } },
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
