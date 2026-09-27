import type { ContentInput, Space } from "spectrum-ts";
import type { PlanDoc } from "../contracts.ts";
import type { SpaceRef } from "../plan.ts";
import { rememberSpace } from "../plan.ts";
import { botLog } from "../log.ts";

export type SpaceLookup = {
  get(id: string, extra?: { phone?: string }): Promise<Space>;
  create?(user: string, extra?: { phone?: string }): Promise<Space>;
};

function linePhone(space: Space): string | undefined {
  return "phone" in space && typeof (space as { phone?: unknown }).phone === "string"
    ? (space as { phone: string }).phone
    : undefined;
}

async function openStored(lookup: SpaceLookup, ref: SpaceRef): Promise<Space | null> {
  try {
    return await lookup.get(ref.spaceId, ref.linePhone ? { phone: ref.linePhone } : undefined);
  } catch (err) {
    console.error("space.get failed", ref, err);
    return null;
  }
}

// Cloud DMs look like `<line>;-;<peer>`. The other participant's thread is
// the same line with their number swapped in — no stored SpaceRef required.
function siblingSpaceId(from: Space, userId: string): string | null {
  const id = from.id ?? "";
  const cut = id.lastIndexOf(";-;");
  if (cut < 0) return null;
  return `${id.slice(0, cut)};-;${userId}`;
}

function track(planId: string, userId: string, space: Space): void {
  const phone = linePhone(space);
  rememberSpace(planId, userId, phone ? { id: space.id, phone } : { id: space.id });
}

// `responding()` is tied to the inbound message. Wrapping a *different* DM
// in it can dump the recap into the voter's thread and skip everyone else.
async function deliver(dest: Space, content: ContentInput, inbound: Space): Promise<void> {
  if (dest.id === inbound.id) {
    await dest.responding(async () => {
      await dest.send(content);
    });
    return;
  }
  await dest.send(content);
}

// DM spaces are remembered in-process. After a restart (or if `go` never
// stored the host), the other phone has no SpaceRef — reopen that 1:1 so a
// later voter can still fan the recap back.
async function destFor(
  lookup: SpaceLookup,
  stored: Record<string, SpaceRef>,
  planId: string,
  userId: string,
  fromGo: { userId: string; space: Space },
): Promise<Space | null> {
  if (userId === fromGo.userId) return fromGo.space;

  const ref = stored[userId];
  const existing = ref ? await openStored(lookup, ref) : null;
  if (existing) return existing;

  const extra = linePhone(fromGo.space);
  const sibling = siblingSpaceId(fromGo.space, userId);
  if (sibling) {
    try {
      const opened = await lookup.get(sibling, extra ? { phone: extra } : undefined);
      track(planId, userId, opened);
      botLog("reopened sibling DM for fan-out", userId);
      return opened;
    } catch (err) {
      console.error("sibling space.get failed", sibling, err);
    }
  }

  if (!lookup.create) {
    console.error("no space for participant", userId);
    return null;
  }
  try {
    const opened = extra ? await lookup.create(userId, { phone: extra }) : await lookup.create(userId);
    track(planId, userId, opened);
    botLog("reopened DM for fan-out", userId);
    return opened;
  } catch (err) {
    console.error("space.create failed", userId, err);
    return null;
  }
}

// One participant, not everyone. The flex whisper goes to the person who could
// move, who is usually not whoever sent `go`.
export async function sendTo(
  lookup: SpaceLookup,
  stored: Record<string, SpaceRef>,
  userId: string,
  content: ContentInput,
  fromGo: { userId: string; space: Space },
  planId?: string,
): Promise<boolean> {
  const dest = await destFor(lookup, stored, planId ?? "", userId, fromGo);
  if (!dest) return false;
  try {
    await deliver(dest, content, fromGo.space);
    return true;
  } catch (err) {
    console.error("whisper send failed", userId, err);
    return false;
  }
}

export async function fanOut(
  lookup: SpaceLookup,
  plan: PlanDoc,
  stored: Record<string, SpaceRef>,
  content: ContentInput,
  fromGo: { userId: string; space: Space },
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const userId of plan.participants) {
    const dest = await destFor(lookup, stored, plan._id, userId, fromGo);
    if (!dest) {
      failed += 1;
      continue;
    }

    try {
      await deliver(dest, content, fromGo.space);
      sent += 1;
      botLog("fan-out ok", userId);
    } catch (err) {
      failed += 1;
      console.error("fan-out send failed", userId, err);
    }
  }

  return { sent, failed };
}
