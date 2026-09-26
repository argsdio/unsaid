import { MongoClient } from "mongodb";
import type { RoundLog, Slots, UserDoc } from "./contracts.ts";

export type Store = {
  getSlots(planId: string, userId: string): Promise<Slots>;
  getAllSlots(planId: string): Promise<Record<string, Slots>>;
  setSlots(planId: string, userId: string, slots: Slots): Promise<void>;
  getUser(userId: string): Promise<UserDoc | null>;
  upsertUser(user: UserDoc): Promise<void>;
  appendRound(round: RoundLog): Promise<void>;
  listRounds(planId: string): Promise<RoundLog[]>;
  close(): Promise<void>;
};

// Without MONGODB_URI everything runs in memory, so the harness and the backroom
// screen do not wait on an Atlas cluster.
function memoryStore(): Store {
  const slots = new Map<string, Slots>();
  const users = new Map<string, UserDoc>();
  const rounds: RoundLog[] = [];
  const key = (planId: string, userId: string) => `${planId}:${userId}`;

  return {
    async getSlots(planId, userId) {
      return slots.get(key(planId, userId)) ?? {};
    },
    async getAllSlots(planId) {
      const out: Record<string, Slots> = {};
      for (const [k, v] of slots) {
        const [plan, user] = k.split(":");
        if (plan === planId && user) out[user] = v;
      }
      return out;
    },
    async setSlots(planId, userId, value) {
      slots.set(key(planId, userId), value);
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
  const plans = db.collection("plans");
  const users = db.collection<UserDoc>("users");
  const rounds = db.collection<RoundLog>("rounds");

  return {
    async getSlots(planId, userId) {
      const plan = await plans.findOne({ _id: planId as never });
      return ((plan?.slots as Record<string, Slots> | undefined) ?? {})[userId] ?? {};
    },
    async getAllSlots(planId) {
      const plan = await plans.findOne({ _id: planId as never });
      return (plan?.slots as Record<string, Slots> | undefined) ?? {};
    },
    // Touches only this user's key, so A's writes to participants and status survive.
    async setSlots(planId, userId, value) {
      await plans.updateOne(
        { _id: planId as never },
        { $set: { [`slots.${userId}`]: value } },
        { upsert: true },
      );
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

export async function openStore(): Promise<Store> {
  const uri = process.env.MONGODB_URI;
  return uri ? mongoStore(uri) : memoryStore();
}
