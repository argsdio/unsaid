import type { HandleDMResult, Occasion, RequiredSlot } from "./contracts.ts";
import { botLog } from "./log.ts";

const NESSIE_BASE = "http://api.nessieisreal.com";

type DinnerCharge = { merchant: string; amount: number };

// Seeded Capital One-shaped ledgers. typical is never stored — it is the median
// of these amounts at ask time, so the number on the phone is computed, not picked.
const POOL: DinnerCharge[][] = [
  [
    { merchant: "Joe's Pizza", amount: 16 },
    { merchant: "Xi'an Famous Foods", amount: 14 },
    { merchant: "Mamoun's Falafel", amount: 19 },
    { merchant: "Joe's Pizza", amount: 22 },
  ],
  [
    { merchant: "Superiority Burger", amount: 24 },
    { merchant: "Vanessa's Dumpling", amount: 18 },
    { merchant: "Taim", amount: 31 },
    { merchant: "Superiority Burger", amount: 27 },
  ],
  [
    { merchant: "Rubirosa", amount: 42 },
    { merchant: "The Smith", amount: 38 },
    { merchant: "Paulie Gee's", amount: 29 },
    { merchant: "Rubirosa", amount: 44 },
  ],
  [
    { merchant: "Lilia", amount: 54 },
    { merchant: "Via Carota", amount: 61 },
    { merchant: "Carbone", amount: 72 },
    { merchant: "Lilia", amount: 49 },
  ],
];

const offered = new Map<string, number>();

const B_BUDGET_ASKS = [
  'Last thing — roughly what are you thinking budget-wise? "cheap" works too.',
  "Roughly how many dollars per person? A number is fine.",
];

function hashUser(userId: string): number {
  let h = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function medianDollars(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  const rounded = Math.round(raw);
  return rounded >= 8 ? rounded : null;
}

function looksLikeDinner(purchase: { amount?: unknown; description?: unknown; merchant_id?: unknown }): boolean {
  const amount = typeof purchase.amount === "number" ? purchase.amount : Number(purchase.amount);
  if (!Number.isFinite(amount) || amount < 8 || amount > 120) return false;
  const blob = `${purchase.description ?? ""} ${purchase.merchant_id ?? ""}`.toLowerCase();
  if (!blob.trim()) return true;
  return /food|restaurant|dining|pizza|taco|sushi|ramen|burger|cafe|grill|bar|kitchen|bistro|noodle/.test(blob);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`nessie ${res.status}`);
  return res.json();
}

function chargeFromPurchase(purchase: {
  amount?: unknown;
  description?: unknown;
  merchant_id?: unknown;
}): DinnerCharge | null {
  const amount = typeof purchase.amount === "number" ? purchase.amount : Number(purchase.amount);
  if (!looksLikeDinner(purchase) || !Number.isFinite(amount)) return null;
  const merchant =
    (typeof purchase.description === "string" && purchase.description.trim()) ||
    (typeof purchase.merchant_id === "string" && purchase.merchant_id) ||
    "dinner";
  return { merchant, amount };
}

async function chargesFromApi(userId: string): Promise<DinnerCharge[] | null> {
  const key = process.env.NESSIE_API_KEY?.trim();
  if (!key) return null;

  const customers = await getJson(`${NESSIE_BASE}/customers?key=${encodeURIComponent(key)}`);
  if (!Array.isArray(customers) || customers.length === 0) return null;
  const customer = customers[hashUser(userId) % customers.length] as { _id?: string };
  if (!customer?._id) return null;

  const accounts = await getJson(
    `${NESSIE_BASE}/customers/${customer._id}/accounts?key=${encodeURIComponent(key)}`,
  );
  if (!Array.isArray(accounts)) return null;

  const charges: DinnerCharge[] = [];
  for (const account of accounts as Array<{ _id?: string }>) {
    if (!account._id) continue;
    const purchases = await getJson(
      `${NESSIE_BASE}/accounts/${account._id}/purchases?key=${encodeURIComponent(key)}`,
    );
    if (!Array.isArray(purchases)) continue;
    for (const purchase of purchases as Array<{ amount?: unknown; description?: unknown; merchant_id?: unknown }>) {
      const charge = chargeFromPurchase(purchase);
      if (charge) charges.push(charge);
    }
  }
  return charges.length ? charges.slice(-6) : null;
}

export type NessiePull = {
  typical: number;
  charges: DinnerCharge[];
  source: "api" | "sandbox";
};

export async function pullDinnerSpend(userId: string): Promise<NessiePull> {
  try {
    const live = await chargesFromApi(userId);
    const typical = live ? medianDollars(live.map((c) => c.amount)) : null;
    if (live && typical) {
      botLog("nessie median from API purchases", { userId, typical, charges: live });
      return { typical, charges: live, source: "api" };
    }
  } catch (err) {
    botLog("nessie API skipped, using seeded purchases", { userId, err: String(err) });
  }

  const charges = POOL[hashUser(userId) % POOL.length] ?? POOL[0]!;
  const typical = medianDollars(charges.map((c) => c.amount)) ?? 30;
  botLog("nessie median from seeded purchases", { userId, typical, charges });
  return { typical, charges, source: "sandbox" };
}

function budgetQuestion(pull: NessiePull, occasion: Occasion): string {
  const lines = pull.charges.map((c) => `• ${c.merchant} · $${c.amount}`).join("\n");
  const via = pull.source === "api" ? "Nessie (live)" : "Nessie";
  // Not "your last dinners" and not "tonight": the plan may be Monday brunch.
  return [
    `${via} pulled what you usually spend:`,
    lines,
    `Median of those: $${pull.typical}. Still good for ${occasion}?`,
  ].join("\n");
}

export function forgetNessieOffer(userId: string): void {
  offered.delete(userId);
}

function isNessieYes(text: string): boolean {
  return /^(yes|yep|yeah|y|ok|okay|sure|still good|that's fine|thats fine|sounds good|works|good)\s*[.!]?$/i.test(
    text.trim(),
  );
}

export function rewriteNessieAnswer(userId: string, text: string, nextMissing: RequiredSlot | undefined): string {
  if (nextMissing !== "budgetCapUSD") return text;
  const typical = offered.get(userId);
  if (typical == null || !isNessieYes(text)) return text;
  botLog("nessie yes → budgetCapUSD", { userId, typical });
  return `$${typical}`;
}

export async function overlayNessieQuestion(
  userId: string,
  result: HandleDMResult,
  occasion: Occasion = "dinner",
): Promise<string> {
  if (result.missing[0] !== "budgetCapUSD") return result.reply;
  const pull = await pullDinnerSpend(userId);
  offered.set(userId, pull.typical);
  const q = budgetQuestion(pull, occasion);
  for (const ask of B_BUDGET_ASKS) {
    if (result.reply.includes(ask)) return result.reply.replace(ask, q);
  }
  return q;
}