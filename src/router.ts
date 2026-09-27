import type { Message, Space } from "spectrum-ts";
import type { HandleDMResult } from "./contracts.ts";
import type { PlanDoc } from "./contracts.ts";
import type { Store } from "./db.ts";
import { fanOut, sendTo, type SpaceLookup } from "./orchestrator/fanout.ts";
import { type NegotiateOutcome, resumeAfterWhisper, runNegotiation } from "./orchestrator/negotiate.ts";
import { parseVote, tallyVotes } from "./voting.ts";
import { resolveDate } from "./resolve/date.ts";
import { venueById } from "./venues.ts";
import { everyoneIn, waitingOnOthers } from "./orchestrator/messages.ts";
import {
  abandonPlan,
  activePlan,
  cardFor,
  createPlan,
  forgetSpaces,
  goBlockers,
  goReadiness,
  isHost,
  joinPlan,
  logGoReadiness,
  markConfirm,
  parseAddFavorite,
  parseConfirmText,
  parseForgetMe,
  parseGo,
  parseJoin,
  parseLeave,
  forgetUser,
  rememberCard,
  rememberSpace,
  saveFavorite,
  shareText,
  spacesFor,
  waitingIds,
  isConfirmEmoji,
} from "./plan.ts";
import { overlayNessieQuestion, rewriteNessieAnswer } from "./nessie.ts";
import { handleDM, missingSlots } from "./slots.ts";
import { planStatus, parseStatus } from "./status.ts";
import { botLog, slotSnapshot } from "./log.ts";

function spaceKind(space: unknown): "dm" | "group" | "unknown" {
  if (typeof space === "object" && space !== null && "type" in space) {
    const type = (space as { type: unknown }).type;
    if (type === "dm" || type === "group") return type;
  }
  return "unknown";
}

function senderId(message: Message, space: Space): string {
  return message.sender?.id ?? `space:${space.id}`;
}

function asTrackedSpace(space: Space): { id: string; phone?: string } {
  const phone =
    "phone" in space && typeof (space as { phone?: unknown }).phone === "string"
      ? (space as { phone: string }).phone
      : undefined;
  return { id: space.id, phone };
}

async function send(space: Space, text: string, reason: string): Promise<void> {
  botLog(`send (${reason})`, text);
  await space.responding(async () => {
    await space.send(text);
  });
}

async function sendHandleDM(
  space: Space,
  userId: string,
  result: HandleDMResult,
  reason: string,
  prefix = "",
): Promise<void> {
  const body = await overlayNessieQuestion(userId, result);
  await send(space, prefix ? `${prefix}${body}` : body, reason);
}

async function onGo(
  space: Space,
  userId: string,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  const plan = await activePlan(store, userId);
  if (!plan) {
    await send(space, "You're not on a plan yet. Text dinner plans to create one, or JOIN a code.", "go: no active plan");
    return;
  }

  if (!isHost(plan, userId)) {
    await send(space, "Only the host can send go.", "go: sender is not host");
    return;
  }

  if (plan.status === "proposed" || plan.status === "confirmed") {
    await send(space, "The plan is already out. Tap 👍 on the card if you haven't.", "go: already proposed/confirmed");
    return;
  }

  if (plan.status === "negotiating") {
    await send(space, "Working on it.", "go: already negotiating");
    return;
  }

  const readiness = await goReadiness(store, plan);
  logGoReadiness(readiness);
  const blocked = goBlockers(readiness);
  if (blocked.length > 0) {
    const labels: Record<string, string> = {
      home: "location",
      window: "time",
      maxTravelMin: "travel",
      dietary: "diet",
      budgetCapUSD: "budget",
    };
    const waitingFields = [...new Set(blocked.flatMap((row) => row.missing))];
    const listed = waitingFields.map((key) => labels[key] ?? key).join(", ");
    const people =
      blocked.length === 1 ? "1 person" : `${blocked.length} people`;
    await send(
      space,
      `Still waiting on ${people} (${listed}). They'll get “got everything” when those are done.`,
      `go: refused, ${people} incomplete`,
    );
    return;
  }

  await store.setStatus(plan._id, "negotiating");
  const outcome = await runNegotiation(store, plan);

  await deliverOutcome(outcome, store, plan, lookup, userId, space);
}

// Shared by `go` and by an answer to a private question, so a resumed
// negotiation behaves exactly like a fresh one.
async function deliverOutcome(
  outcome: NegotiateOutcome,
  store: Store,
  plan: PlanDoc,
  lookup: SpaceLookup,
  userId: string,
  space: Space,
): Promise<void> {
  if (!outcome.ok) {
    if ("ask" in outcome) {
      // Paused, not failed. The plan stays `negotiating`, and the question goes to
      // the one person who could move -- usually not whoever sent `go`.
      const pausedPlan = (await store.getPlan(plan._id)) ?? plan;
      await sendTo(lookup, spacesFor(pausedPlan), outcome.ask.userId, outcome.ask.question, {
        userId,
        space,
      });
      if (outcome.ask.userId !== userId) {
        await send(space, "Checking one thing with someone. Back shortly.", "go: paused on a whisper");
      }
      return;
    }
    await store.setStatus(plan._id, "collecting");
    await send(space, outcome.text, "go: negotiation failed (see go: logs above)");
    return;
  }

  if (outcome.shortlist.length > 1) await store.setShortlist(plan._id, outcome.shortlist);
  const latest = (await store.getPlan(plan._id)) ?? plan;
  await store.setStatus(plan._id, "proposed");
  rememberCard(plan._id, outcome.text);
  const result = await fanOut(lookup, latest, spacesFor(latest), outcome.text, { userId, space });
  console.log("go", { planId: plan._id, shortlist: outcome.shortlist, ...result });
  if (result.failed > 0 && result.sent > 0) {
    await send(
      space,
      `Sent the plan to ${result.sent} of ${plan.participants.length}. Someone may need to text Unsaid again.`,
      "go: fan-out partial failure",
    );
  }
}

export async function onDirectText(
  space: Space,
  message: Message,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  if (message.content.type !== "text") return;
  const text = message.content.text.trim();
  if (!text) return;

  const userId = senderId(message, space);
  const tracked = asTrackedSpace(space);
  const joinCode = parseJoin(text);
  const current = await activePlan(store, userId);
  botLog("inbound", { userId, text, hasPlan: Boolean(current), planStatus: current?.status });

  if (joinCode) {
    const joined = await joinPlan(store, userId, joinCode, tracked);
    if ("error" in joined) {
      await send(space, joined.error, "join: unknown or retired code");
      return;
    }
    const dm = await handleDM(
      { planId: joined.plan._id, userId, text: "ready to join" },
      store,
    );
    await sendHandleDM(
      space,
      userId,
      dm,
      "join: attached + handleDM",
      `You're in (${joined.plan.joinCode}).\n\n`,
    );
    console.log("join", { userId, planId: joined.plan._id, joinCode: joined.plan.joinCode });
    return;
  }

  if (parseForgetMe(text)) {
    await send(space, await forgetUser(store, userId), "forget me: user wiped");
    return;
  }

  if (parseLeave(text)) {
    const plan = await activePlan(store, userId);
    const snapshot = plan ? spacesFor(plan) : {};
    const { message, notify } = await abandonPlan(store, userId);
    if (notify) {
      await fanOut(lookup, notify, snapshot, "Host cancelled this plan. Text Unsaid to start a new one, or JOIN a new code.", {
        userId,
        space,
      });
      forgetSpaces(notify._id);
    } else {
      await send(space, message, "leave: self only");
    }
    return;
  }

  const favorite = parseAddFavorite(text);
  if (favorite) {
    if (current) rememberSpace(current._id, userId, tracked);
    await send(space, await saveFavorite(store, userId, favorite), "favorite: saved without slot-fill");
    return;
  }

  if (parseStatus(text)) {
    await send(space, await planStatus(store, current?._id, userId), "status");
    return;
  }

  if (parseGo(text)) {
    await onGo(space, userId, store, lookup);
    return;
  }

  if (!current) {
    const plan = await createPlan(store, userId, tracked);

    // "dinner friday?" means Friday. Without this every plan is silently today.
    const when = resolveDate(text);
    if (when) {
      const iso = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
      await store.setPlanDate(plan._id, iso);
      botLog("plan date", { planId: plan._id, from: text, date: iso });
    }
    const dm = await handleDM({ planId: plan._id, userId, text }, store);
    await sendHandleDM(
      space,
      userId,
      dm,
      "create: new plan + handleDM",
      `${shareText(plan.joinCode)}\n\n`,
    );
    console.log("create", { userId, planId: plan._id, joinCode: plan.joinCode });
    return;
  }

  if (current.status === "negotiating") {
    await send(space, "Working on it.", "inbound ignored: status negotiating");
    return;
  }

  if (current.status === "confirmed") {
    await send(space, "You're all set — everyone's already in.", "inbound ignored: status confirmed");
    return;
  }

  if (current.status === "proposed") {
    if (parseConfirmText(text)) {
      await onConfirm(space, userId, store, lookup);
      return;
    }

    const shortlist = current.shortlist ?? [];
    if (shortlist.length > 1) {
      const picked = parseVote(text, shortlist);
      if (picked) {
        await castVote(space, store, lookup, current, userId, picked);
        return;
      }
    }

    // Not a vote and not a tapback. Previously every one of these got the same
    // canned line, twice in a row if you kept talking. Say something that
    // depends on what the person has actually done.
    const mine = current.votes?.[userId];
    if (mine) {
      const outstanding = current.participants.length - Object.keys(current.votes ?? {}).length;
      await send(
        space,
        outstanding > 0
          ? `You picked ${venueById(mine)?.name ?? mine}. Waiting on ${outstanding} more.`
          : `You picked ${venueById(mine)?.name ?? mine}. Counting them now.`,
        "proposed: already voted",
      );
    } else if (shortlist.length > 1) {
      const options = shortlist
        .map((id, i) => `${i + 1}. ${venueById(id)?.name ?? id}`)
        .join("\n");
      await send(
        space,
        `Still open — reply with a number and I'll count it.\n\n${options}`,
        "proposed: nudge to vote",
      );
    } else {
      await send(space, "Tap 👍 on the card if that works for you.", "proposed: nudge to confirm");
    }
    return;
  }

  rememberSpace(current._id, userId, tracked);

  // Answering their own agent's private question, not filling a slot. This must
  // come before handleDM or the answer is swallowed and the plan hangs forever.
  const paused = await store.getNegotiation(current._id);
  if (paused?.pendingAsk?.userId === userId) {
    botLog("whisper answer", { userId, planId: current._id, text });
    const resumed = await resumeAfterWhisper(store, current, text);
    await deliverOutcome(resumed, store, current, lookup, userId, space);
    return;
  }

  const nextAsk = missingSlots(await store.getSlots(current._id, userId))[0];
  const forSlots = rewriteNessieAnswer(userId, text, nextAsk);
  botLog("handleDM inbound", { userId, planId: current._id, text: forSlots });
  const dm = await handleDM({ planId: current._id, userId, text: forSlots }, store);
  botLog("handleDM stored slots after parse", { userId, missing: dm.missing, ...slotSnapshot(dm.slots) });
  await sendHandleDM(
    space,
    userId,
    dm,
    `handleDM next question (missing: ${dm.missing.join(", ") || "none"})`,
  );
}

// A vote arrives as "2", "#2", "option 2" or the venue's name. When the last
// person votes, the winner is announced to everyone.
async function castVote(
  space: Space,
  store: Store,
  lookup: SpaceLookup,
  plan: PlanDoc,
  userId: string,
  venueId: string,
): Promise<void> {
  await store.recordVote(plan._id, userId, venueId);
  const latest = (await store.getPlan(plan._id)) ?? plan;
  const votes = latest.votes ?? {};
  const shortlist = latest.shortlist ?? [];
  const cast = Object.keys(votes).length;
  const need = latest.participants.length;
  const name = venueById(venueId)?.name ?? venueId;
  botLog("vote", { userId, venueId, cast, need });

  if (cast < need) {
    await send(space, `${name} — got it. Waiting on ${need - cast} more.`, "vote recorded");
    return;
  }

  const { winner, counts } = tallyVotes(votes, shortlist);
  const venue = winner ? venueById(winner) : undefined;
  if (!venue || !winner) {
    await send(space, `${name} — got it.`, "vote recorded, no winner");
    return;
  }

  await store.setStatus(plan._id, "confirmed");
  const settled = (await store.getPlan(plan._id)) ?? latest;
  // Name a tie rather than announcing a winner nobody outvoted -- somebody who
  // voted the other way should see why this one won, not just that it did.
  const top = counts[winner] ?? 0;
  const tied = Object.values(counts).filter((n) => n === top).length > 1;
  const tally = tied
    ? `Split ${Object.values(counts).join("-")}, so I went with the one that scored best for everyone.`
    : top === need
      ? "Unanimous."
      : `${top} of ${need} votes.`;
  const result = await fanOut(
    lookup,
    settled,
    spacesFor(settled),
    `Settled: ${venue.name} (${venue.neighborhood}) · about $${venue.estCostUSD}. ${tally}`,
    { userId, space },
  );
  botLog("vote: settled", { winner, counts, ...result });
}

async function onConfirm(
  space: Space,
  userId: string,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  const plan = await activePlan(store, userId);
  if (!plan) {
    botLog("tapback ignored: no active plan", { userId });
    return;
  }

  rememberSpace(plan._id, userId, asTrackedSpace(space));

  if (plan.status === "confirmed") {
    botLog("tapback ignored: already confirmed", { userId, planId: plan._id });
    return;
  }

  if (plan.status !== "proposed") {
    botLog("tapback ignored: plan not proposed yet", { userId, planId: plan._id, status: plan.status });
    return;
  }

  const { first, have } = markConfirm(plan._id, userId);
  const need = plan.participants.length;
  const waiting = waitingIds(plan);
  botLog("confirm", { userId, planId: plan._id, first, have, need, waiting });

  if (have < need) {
    if (first) {
      await send(space, waitingOnOthers(have, need), "confirm: waiting on others");
    }
    return;
  }

  await store.setStatus(plan._id, "confirmed");
  const latest = (await store.getPlan(plan._id)) ?? plan;
  await fanOut(lookup, latest, spacesFor(latest), everyoneIn(cardFor(plan._id)), {
    userId,
    space,
  });
}

function reactionEmoji(message: Message): string | null {
  const content = message.content as { type?: string; emoji?: unknown };
  if (content.type !== "reaction" || typeof content.emoji !== "string") return null;
  return content.emoji;
}

export async function routeMessage(
  space: Space,
  message: Message,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  if (message.direction === "outbound") return;

  if (spaceKind(space) === "group") {
    console.log("skipping group message", space.id);
    return;
  }

  const emoji = reactionEmoji(message);
  if (emoji !== null) {
    const userId = senderId(message, space);
    botLog("inbound reaction", { userId, emoji });
    if (!isConfirmEmoji(emoji)) {
      botLog("tapback ignored: not a confirm emoji", { userId, emoji });
      return;
    }
    await onConfirm(space, userId, store, lookup);
    return;
  }

  // A tap on a native poll. Spectrum delivers it as its own content kind rather
  // than as text, so without this the vote is silently dropped.
  if (message.content.type === "poll_option") {
    const userId = senderId(message, space);
    const choice = message.content as { selected?: boolean; title?: string; option?: { title?: string } };
    const title = choice.option?.title ?? choice.title ?? "";
    botLog("inbound poll vote", { userId, title, selected: choice.selected });
    if (choice.selected === false || !title) return;

    const plan = await activePlan(store, userId);
    if (!plan || plan.status !== "proposed") return;
    const picked = parseVote(title, plan.shortlist ?? []);
    if (picked) await castVote(space, store, lookup, plan, userId, picked);
    return;
  }

  if (message.content.type !== "text") {
    botLog("inbound skipped: unsupported content", {
      type: message.content.type,
      keys: Object.keys(message.content),
    });
    return;
  }

  await onDirectText(space, message, store, lookup);
}
