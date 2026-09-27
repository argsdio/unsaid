import type { Space } from "spectrum-ts";
import type { PlanDoc } from "../contracts.ts";
import type { SpaceRef } from "../plan.ts";

export type SpaceLookup = {
  get(id: string, extra?: { phone?: string }): Promise<Space>;
};

async function openStored(lookup: SpaceLookup, ref: SpaceRef): Promise<Space | null> {
  try {
    return await lookup.get(ref.spaceId, ref.linePhone ? { phone: ref.linePhone } : undefined);
  } catch (err) {
    console.error("space.get failed", ref, err);
    return null;
  }
}

export async function fanOut(
  lookup: SpaceLookup,
  plan: PlanDoc,
  stored: Record<string, SpaceRef>,
  text: string,
  fromGo: { userId: string; space: Space },
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (const userId of plan.participants) {
    let dest: Space | null = null;
    if (userId === fromGo.userId) {
      dest = fromGo.space;
    } else {
      const ref = stored[userId];
      dest = ref ? await openStored(lookup, ref) : null;
    }

    if (!dest) {
      failed += 1;
      console.error("no space for participant", userId);
      continue;
    }

    try {
      await dest.responding(async () => {
        await dest!.send(text);
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error("fan-out send failed", userId, err);
    }
  }

  return { sent, failed };
}
