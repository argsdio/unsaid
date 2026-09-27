import type { Message, Space } from "spectrum-ts";
import type { HandleDMResult } from "./contracts.ts";
import type { Store } from "./db.ts";
import { fanOut, type SpaceLookup } from "./orchestrator/fanout.ts";
import { runNegotiation } from "./orchestrator/negotiate.ts";
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

  if (!outcome.ok) {
    await store.setStatus(plan._id, "collecting");
    await send(space, outcome.text, "go: negotiation failed (see go: logs above)");
    return;
  }

  const latest = (await store.getPlan(plan._id)) ?? plan;
  await store.setStatus(plan._id, "proposed");
  rememberCard(plan._id, outcome.text);
  const result = await fanOut(lookup, latest, spacesFor(latest), outcome.text, { userId, space });
  console.log("go", { planId: plan._id, ...result });
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
    await send(space, "The plan is already out. Tap 👍 on the card to confirm.", "inbound ignored: status proposed");
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
  );
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

  if (message.content.type !== "text") {
    botLog("inbound skipped: unsupported content", {
      type: message.content.type,
      keys: Object.keys(message.content),
    });
    return;
  }

  await onDirectText(space, message, store, lookup);
}
