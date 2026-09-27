import type { Message, Space } from "spectrum-ts";
import type { Store } from "./db.ts";
import { fanOut, type SpaceLookup } from "./orchestrator/fanout.ts";
import { runNegotiation } from "./orchestrator/negotiate.ts";
import {
  abandonPlan,
  activePlan,
  createPlan,
  forgetSpaces,
  isHost,
  joinPlan,
  parseAddFavorite,
  parseGo,
  parseJoin,
  parseLeave,
  rememberSpace,
  saveFavorite,
  shareText,
  spacesFor,
} from "./plan.ts";
import { handleDM, missingSlots } from "./slots.ts";

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

async function send(space: Space, text: string): Promise<void> {
  await space.responding(async () => {
    await space.send(text);
  });
}

async function onGo(
  space: Space,
  userId: string,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  const plan = await activePlan(store, userId);
  if (!plan) {
    await send(space, "You're not on a plan yet. Text dinner plans to create one, or JOIN a code.");
    return;
  }

  if (!isHost(plan, userId)) {
    await send(space, "Only the host can send go.");
    return;
  }

  if (plan.status === "proposed" || plan.status === "confirmed") {
    await send(space, "The plan is already out. Tap 👍 on the card if you haven't.");
    return;
  }

  if (plan.status === "negotiating") {
    await send(space, "Working on it.");
    return;
  }

  const waitingFields = new Set<string>();
  for (const participant of plan.participants) {
    const slots = await store.getSlots(plan._id, participant);
    for (const key of missingSlots(slots)) waitingFields.add(key);
  }
  if (waitingFields.size > 0) {
    const labels: Record<string, string> = {
      home: "location",
      window: "time",
      maxTravelMin: "travel",
      dietary: "diet",
      budgetCapUSD: "budget",
    };
    const listed = [...waitingFields].map((key) => labels[key] ?? key).join(", ");
    await send(
      space,
      `Still waiting on everyone's ${listed}. They'll get “got everything” when those are done.`,
    );
    return;
  }

  await store.setStatus(plan._id, "negotiating");
  const outcome = await runNegotiation(store, plan);

  if (!outcome.ok) {
    await store.setStatus(plan._id, "collecting");
    await send(space, outcome.text);
    return;
  }

  const latest = (await store.getPlan(plan._id)) ?? plan;
  await store.setStatus(plan._id, "proposed");
  const result = await fanOut(lookup, latest, spacesFor(latest), outcome.text, { userId, space });
  console.log("go", { planId: plan._id, ...result });
  if (result.failed > 0 && result.sent > 0) {
    await send(
      space,
      `Sent the plan to ${result.sent} of ${plan.participants.length}. Someone may need to text Unsaid again.`,
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

  if (joinCode) {
    const result = await joinPlan(store, userId, joinCode, tracked);
    if ("error" in result) {
      await send(space, result.error);
      return;
    }
    const { reply } = await handleDM(
      { planId: result.plan._id, userId, text: "ready to join" },
      store,
    );
    await send(space, `You're in (${result.plan.joinCode}).\n\n${reply}`);
    console.log("join", { userId, planId: result.plan._id, joinCode: result.plan.joinCode });
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
      await send(space, message);
    }
    return;
  }

  const favorite = parseAddFavorite(text);
  if (favorite) {
    if (current) rememberSpace(current._id, userId, tracked);
    await send(space, await saveFavorite(store, userId, favorite));
    return;
  }

  if (parseGo(text)) {
    await onGo(space, userId, store, lookup);
    return;
  }

  if (!current) {
    const plan = await createPlan(store, userId, tracked);
    const { reply } = await handleDM({ planId: plan._id, userId, text }, store);
    await send(space, `${shareText(plan.joinCode)}\n\n${reply}`);
    console.log("create", { userId, planId: plan._id, joinCode: plan.joinCode });
    return;
  }

  if (current.status === "negotiating") {
    await send(space, "Working on it.");
    return;
  }

  if (current.status === "proposed" || current.status === "confirmed") {
    await send(space, "The plan is already out. Tap 👍 on the card to confirm.");
    return;
  }

  rememberSpace(current._id, userId, tracked);
  const { reply } = await handleDM({ planId: current._id, userId, text }, store);
  await send(space, reply);
}

export async function routeMessage(
  space: Space,
  message: Message,
  store: Store,
  lookup: SpaceLookup,
): Promise<void> {
  if (message.direction === "outbound") return;

  if (message.content.type === "reaction") {
    return;
  }
  if (message.content.type !== "text") return;

  if (spaceKind(space) === "group") {
    console.log("skipping group message", space.id);
    return;
  }

  await onDirectText(space, message, store, lookup);
}
