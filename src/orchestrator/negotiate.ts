import type { PlanDoc } from "../contracts.ts";
import type { Participant } from "../aggregator.ts";
import type { Store } from "../db.ts";
import { negotiate, resumeNegotiation } from "../negotiation.ts";
import { venueById } from "../venues.ts";
import { botLog, slotSnapshot } from "../log.ts";
import { nothingFits, pickTime, planCard, whenLabel } from "./messages.ts";

export type NegotiateOutcome =
  // A shortlist of up to three. `poll` is the same options as a Spectrum poll
  // payload, ready for space.send(poll(title, ...options.map(option))) when
  // fan-out is upgraded to send content rather than a string.
  | { ok: true; text: string; shortlist: string[]; poll?: { title: string; options: string[] } }
  | { ok: false; text: string }
  // Paused: one person is being asked privately whether they can flex.
  | { ok: false; ask: { userId: string; question: string } };

// The rounds, objections and concessions live in src/negotiation.ts (contract
// 12). This file gathers participants, logs, and turns the outcome into a
// message -- it does not decide anything.
// The day the plan is for, so window intersection and blackout clipping use the
// right weekday.
function planDay(plan: PlanDoc): Date {
  return plan.date ? new Date(`${plan.date}T12:00:00`) : new Date();
}

async function participantsOf(store: Store, plan: PlanDoc): Promise<Participant[]> {
  const people: Participant[] = [];
  for (const userId of plan.participants) {
    const slots = await store.getSlots(plan._id, userId);
    people.push({ userId, slots });
    botLog("go: stored slots for participant", { userId, ...slotSnapshot(slots) });
  }
  return people;
}

// A person answered their agent's private question. Same outcome shape as `go`,
// so the router handles both identically.
export async function resumeAfterWhisper(
  store: Store,
  plan: PlanDoc,
  text: string,
): Promise<NegotiateOutcome> {
  const people = await participantsOf(store, plan);
  return toOutcome(store, plan, await resumeNegotiation(store, plan._id, people, text, planDay(plan)));
}

export async function runNegotiation(store: Store, plan: PlanDoc): Promise<NegotiateOutcome> {
  const people = await participantsOf(store, plan);
  return toOutcome(store, plan, await negotiate(store, plan._id, people, planDay(plan)));
}

async function toOutcome(
  store: Store,
  plan: PlanDoc,
  result: Awaited<ReturnType<typeof negotiate>>,
): Promise<NegotiateOutcome> {
  for (const round of result.rounds) await store.appendRound(round);
  botLog("go: negotiation", {
    status: result.status,
    rounds: result.rounds.length,
    transcript: result.rounds.map((r) => r.narration),
  });

  if (result.status === "waiting") {
    botLog("go: paused — asking one person privately", { userId: result.userId });
    return { ok: false, ask: { userId: result.userId, question: result.question } };
  }

  if (result.status === "failed") {
    if (result.reason === "no-overlap") {
      botLog("go: fail — no overlapping time window", result.merged.window);
      return { ok: false, text: nothingFits(["time"]) };
    }
    // `binding` is already the single largest constraint by counterfactual
    // measure, so this names one thing to flex instead of listing every category.
    const area = result.binding && result.binding.kind !== "budget" ? result.binding.kind : "budget";
    botLog("go: fail", { reason: result.reason, binding: result.binding });
    return { ok: false, text: nothingFits([area], plan.occasion) };
  }

  const venues = result.shortlist.flatMap((id) => {
    const v = venueById(id);
    return v ? [v] : [];
  });
  const top = venues[0];
  if (!top) return { ok: false, text: nothingFits(["budget"]) };

  const time = pickTime(result.merged.window);
  botLog("go: shortlist", { venues: venues.map((v) => v.name), time });

  // One option is a decision; several is a choice, and it gives anyone who
  // dislikes the top pick something to do other than object.
  if (venues.length === 1) {
    return {
      ok: true,
      shortlist: result.shortlist,
      text: planCard(top, { venueId: top.id, time, estCostUSD: top.estCostUSD }, plan.occasion, plan.date),
    };
  }

  // pickTime already returns a formatted clock ("7:00 PM"), not an ISO string.
  // Slicing it produced an empty string and the message read "tonight at :".
  const when = whenLabel(plan.occasion, plan.date);
  const lines = venues.map((v, i) => `${i + 1}. ${v.name} (${v.neighborhood}) · about $${v.estCostUSD}`);
  const choices = venues.map((_, i) => i + 1);
  const replyHint =
    choices.length === 2
      ? "Reply 1 or 2."
      : `Reply ${choices.slice(0, -1).join(", ")} or ${choices[choices.length - 1]}.`;
  return {
    ok: true,
    shortlist: result.shortlist,
    poll: {
      title: `${when} at ${time} — which one?`,
      // Price in the label so the native poll carries the same information as
      // the text list. parseVote still matches these by name.
      options: venues.map((v) => `${v.name} · $${v.estCostUSD}`),
    },
    text: [`These all work for everyone, ${when.toLowerCase()} at ${time}:`, "", ...lines, "", replyHint].join("\n"),
  };
}
