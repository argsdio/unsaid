import { type Message, type Space, option, poll } from "spectrum-ts";
import type { HandleDMResult, Occasion, Venue } from "./contracts.ts";
import type { PlanDoc } from "./contracts.ts";
import type { Store } from "./db.ts";
import { fanOut, sendTo, type SpaceLookup } from "./orchestrator/fanout.ts";
import { type NegotiateOutcome, resumeAfterWhisper, runNegotiation } from "./orchestrator/negotiate.ts";
import { parseVote, tallyVotes } from "./voting.ts";
import { classifyMeta } from "./meta.ts";
import { resolveDate } from "./resolve/date.ts";
import { resolveOccasion } from "./resolve/occasion.ts";
import { resolveHome } from "./resolve/location.ts";
import { grokGeocoder } from "./resolve/geocode.ts";
import { tasteWords, transitLink, venueById } from "./venues.ts";
import { everyoneIn, planIntro, settledCard, waitingOnOthers, whenLabel } from "./orchestrator/messages.ts";
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
  occasion?: Occasion,
): Promise<void> {
  const body = await overlayNessieQuestion(userId, result, occasion);
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

  // Stored even when there is only one option: voting is gated on more than one
  // elsewhere, but without this a single-option plan settled by a 👍 had no venue
  // recorded anywhere and could not say where it was.
  await store.setShortlist(plan._id, outcome.shortlist, outcome.time);
  const latest = (await store.getPlan(plan._id)) ?? plan;
  await store.setStatus(plan._id, "proposed");
  rememberCard(plan._id, outcome.text);
  // The native poll is ON by default now: one has rendered correctly on a real
  // phone, a tap registers, and taking a vote back off it works. It was off
  // before that was known, which is why a real run got the numbered text and
  // nobody could tap anything.
  //
  // `UNSAID_POLL=0` forces the numbered text. Keep that in mind on stage: the
  // fallback below only catches a send that THROWS, so if Spectrum accepts a poll
  // that iMessage renders as nothing, no fallback fires. The title carries the
  // reply hint for exactly that case -- a number still works either way.
  const pollEnabled = process.env.UNSAID_POLL !== "0";
  let result = { sent: 0, failed: 0 };
  if (outcome.poll && pollEnabled) {
    try {
      const card = poll(outcome.poll.title, ...outcome.poll.options.map((o) => option(o)));
      result = await fanOut(lookup, latest, spacesFor(latest), card, { userId, space });
    } catch (err) {
      console.error("poll send failed, falling back to text", err);
      result = { sent: 0, failed: 0 };
    }
  }
  if (result.sent === 0) {
    result = await fanOut(lookup, latest, spacesFor(latest), outcome.text, { userId, space });
  }
  botLog("go", { planId: plan._id, shortlist: outcome.shortlist, poll: pollEnabled, ...result });
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
      `You're in (${joined.plan.joinCode}). ${planIntro(joined.plan)}\n\n`,
      joined.plan.occasion,
    );
    botLog("join", { userId, planId: joined.plan._id, joinCode: joined.plan.joinCode });
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

    // "sunday brunch" is both a day and a kind of outing. The occasion decides
    // which venues qualify, what a bare "11" means, and the wording of the card.
    const occasion = resolveOccasion(text);
    await store.setOccasion(plan._id, occasion);
    botLog("plan occasion", { planId: plan._id, from: text, occasion });

    // "boba after class", "somewhere nice" -- the organiser is describing the
    // outing for everybody, so every agent scores against it.
    const vibe = tasteWords(text);
    if (vibe.length) {
      await store.setVibe(plan._id, vibe);
      botLog("plan vibe", { planId: plan._id, vibe });
    }

    // "dinner friday?" means Friday. Without this every plan is silently today.
    const when = resolveDate(text);
    let planDate: string | undefined;
    if (when) {
      planDate = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
      await store.setPlanDate(plan._id, planDate);
      botLog("plan date", { planId: plan._id, from: text, date: planDate });
    }
    const dm = await handleDM({ planId: plan._id, userId, text }, store);
    await sendHandleDM(
      space,
      userId,
      dm,
      "create: new plan + handleDM",
      `${shareText(plan.joinCode, whenLabel(occasion, planDate))}\n\n`,
      occasion,
    );
    botLog("create", { userId, planId: plan._id, joinCode: plan.joinCode });
    return;
  }

  // A paused negotiation is `negotiating`, and the person being asked privately
  // is answering their own agent -- so this has to be read before the
  // still-working bail-out below, which otherwise swallows the answer and leaves
  // the plan paused forever.
  const pausedNow = await store.getNegotiation(current._id);
  if (pausedNow?.pendingAsk?.userId === userId) {
    rememberSpace(current._id, userId, tracked);
    botLog("whisper answer", { userId, planId: current._id, text });
    const resumed = await resumeAfterWhisper(store, current, text);
    await deliverOutcome(resumed, store, current, lookup, userId, space);
    return;
  }

  if (current.status === "negotiating") {
    await send(
      space,
      pausedNow
        ? "Working on it — waiting on one more answer."
        : "Working on it.",
      "inbound ignored: status negotiating",
    );
    return;
  }

  if (current.status === "confirmed") {
    // The settled card invites an address for door-to-door directions, so that
    // has to do something. Anything else still gets the canned line.
    const venue = current.chosen ? venueById(current.chosen.venueId) : undefined;
    const sharper = venue ? await resolveHome(text, grokGeocoder()) : { value: null };
    if (venue && sharper.value) {
      await store.setSlots(current._id, userId, {
        ...(await store.getSlots(current._id, userId)),
        home: { raw: text, value: sharper.value, confidence: "high" },
      });
      await send(
        space,
        [`Got it — ${sharper.value.label}.`, "", `Transit to ${venue.name}: ${transitLink(venue, sharper.value)}`].join("\n"),
        "confirmed: sharper directions",
      );
      return;
    }
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

    // Not a vote and not a tapback. Every one of these used to get the identical
    // canned line, however many times you wrote. Answer the aside where there is
    // one, and otherwise rotate -- never the same string twice running.
    const cast = Object.keys(current.votes ?? {}).length;
    const need = current.participants.length;
    const mine = current.votes?.[userId];
    const list = shortlist.map((id, i) => `${i + 1}. ${venueById(id)?.name ?? id}`).join("\n");
    const meta = classifyMeta(text);

    if (meta === "options" && shortlist.length > 1) {
      await send(space, `On the table:\n\n${list}\n\nReply with a number.`, "proposed: listed options");
      return;
    }
    if (meta === "who") {
      await send(space, `${cast} of ${need} have picked so far.`, "proposed: vote count");
      return;
    }
    if (meta === "help" || meta === "why") {
      await send(
        space,
        `These all cleared everyone's limits, so any of them works. Reply with a number and the most-picked one wins.`,
        "proposed: explained",
      );
      return;
    }

    if (mine) {
      const name = venueById(mine)?.name ?? mine;
      await send(
        space,
        need - cast > 0
          ? `You're down for ${name}. Waiting on ${need - cast} more.`
          : `You're down for ${name}. Counting them now.`,
        "proposed: already voted",
      );
      return;
    }

    if (shortlist.length > 1) {
      const variants = [
        `Still open — reply with a number and I'll count it.\n\n${list}`,
        `Whichever you like, just send the number. ${cast} of ${need} have picked.`,
        `No rush. A number when you've decided, or tap 👍 on the card to take the top one.`,
      ];
      const turn = bumpNudge(current._id, userId);
      await send(space, variants[turn % variants.length]!, `proposed: nudge ${turn + 1}`);
      return;
    }

    await send(space, "Tap 👍 on the card if that works for you.", "proposed: nudge to confirm");
    return;
  }

  rememberSpace(current._id, userId, tracked);

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
    "",
    current.occasion,
  );
}

// A vote arrives as "2", "#2", "option 2" or the venue's name. When the last
// person votes, the winner is announced to everyone.
// Per-conversation nudge counter, so a reminder is never the same string twice
// in a row. Process-local on purpose: losing the count on restart just means
// starting the rotation over, which is harmless.
const nudges = new Map<string, number>();
function bumpNudge(planId: string, userId: string): number {
  const key = `${planId}:${userId}`;
  const next = nudges.get(key) ?? 0;
  nudges.set(key, next + 1);
  return next;
}

// Everyone gets the same facts and their own directions: fanOut sends one
// identical message, so the transit link has to be built per person.
async function announceSettled(
  store: Store,
  lookup: SpaceLookup,
  plan: PlanDoc,
  venue: Venue,
  tally: string | undefined,
  from: { userId: string; space: Space },
): Promise<{ sent: number; failed: number }> {
  const time = plan.proposedTime;
  await store.setChosen(plan._id, {
    venueId: venue.id,
    time: time ?? new Date().toISOString(),
    estCostUSD: venue.estCostUSD,
  });

  let sent = 0;
  let failed = 0;
  for (const userId of plan.participants) {
    const home = (await store.getSlots(plan._id, userId)).home?.value ?? null;
    const card = settledCard(venue, { time, occasion: plan.occasion, date: plan.date, tally, from: home });
    const ok = await sendTo(lookup, spacesFor(plan), userId, card, from);
    if (ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}

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

  const top = counts[winner] ?? 0;
  const tied = Object.values(counts).filter((n) => n === top).length > 1;

  // A tie is not a result. With two people ANY disagreement ties, so silently
  // taking the higher-scoring option overrules somebody every single time --
  // which is exactly what "what kind of democracy is this" was about. Hand it
  // back: say which one the scores favour, and let them settle it.
  if (tied) {
    const split = Object.values(counts).join("–");
    await fanOut(
      lookup,
      latest,
      spacesFor(latest),
      [
        `${split} split — no clear winner.`,
        "",
        `${venue.name} edges it on everyone's scores.`,
        "",
        `Tap 👍 to take it, or reply with a different number to switch your pick.`,
      ].join("\n"),
      { userId, space },
    );
    botLog("vote: tie, handed back", { counts });
    return;
  }

  await store.setStatus(plan._id, "confirmed");
  const settled = (await store.getPlan(plan._id)) ?? latest;
  const tally = top === need ? "Unanimous." : `${top} of ${need} votes.`;
  const result = await announceSettled(store, lookup, settled, venue, tally, { userId, space });
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
  // A 👍 on a single-option card settles it as surely as a vote does, so it gets
  // the same address and directions rather than "Everyone's in."
  const top = (latest.shortlist ?? [])[0] ?? latest.chosen?.venueId;
  const venue = top ? venueById(top) : undefined;
  if (venue) {
    await announceSettled(store, lookup, latest, venue, "Everyone's in.", { userId, space });
  } else {
    await fanOut(lookup, latest, spacesFor(latest), everyoneIn(cardFor(plan._id)), { userId, space });
  }
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
    botLog("skipping group message", space.id);
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

    const plan = await activePlan(store, userId);
    if (!plan || plan.status !== "proposed") return;

    // Un-tapping an option withdraws the vote. Treating it as a no-op left the
    // old choice standing, so the tally disagreed with what the poll showed.
    if (choice.selected === false) {
      await store.removeVote(plan._id, userId);
      const left = plan.participants.length - Object.keys((await store.getPlan(plan._id))?.votes ?? {}).length;
      await send(
        space,
        left > 0 ? `Took your pick back. ${left} still to decide.` : "Took your pick back.",
        "poll vote withdrawn",
      );
      return;
    }
    if (!title) return;
    const picked = parseVote(title, plan.shortlist ?? []);
    if (picked) {
      await castVote(space, store, lookup, plan, userId, picked);
      return;
    }
    // A tap we cannot match to an option would otherwise vanish silently.
    const names = (plan.shortlist ?? []).map((id, i) => `${i + 1}. ${venueById(id)?.name ?? id}`).join("\n");
    await send(space, `I didn't catch which one that was. Reply with a number:\n\n${names}`, "poll vote unmatched");
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
