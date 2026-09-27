import type { Candidate, FailedOn, TimeWindow , Occasion } from "../contracts.ts";
import type { Venue } from "../contracts.ts";

export function pickTime(window: TimeWindow): string {
  const start = new Date(window.start);
  if (Number.isNaN(start.getTime())) return window.start;
  return start.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

// "Tonight" is wrong for a Sunday brunch. Uses the plan's own day and occasion
// so the card says what it actually is.
export function whenLabel(occasion: Occasion = "dinner", date?: string): string {
  if (!date) return occasion === "dinner" ? "Tonight" : `Today's ${occasion}`;
  const day = new Date(`${date}T12:00:00`);
  const today = new Date();
  const sameDay = day.toDateString() === today.toDateString();
  if (sameDay) return occasion === "dinner" ? "Tonight" : `Today's ${occasion}`;
  const weekday = day.toLocaleDateString("en-US", { weekday: "long" });
  return `${weekday} ${occasion}`;
}

export function planCard(
  venue: Venue,
  card: Candidate,
  occasion?: Occasion,
  date?: string,
): string {
  return [
    `${whenLabel(occasion, date)}: ${venue.name} (${venue.neighborhood})`,
    `About $${card.estCostUSD} · ${card.time} ET`,
    "",
    `Tap 👍 if this works for you.`,
  ].join("\n");
}

export function waitingOnOthers(have: number, need: number): string {
  const left = need - have;
  return left === 1
    ? "Got your 👍. Waiting on one more person."
    : `Got your 👍. Waiting on ${left} more people.`;
}

export function everyoneIn(cardText?: string): string {
  const firstLine = cardText?.split("\n")[0]?.trim();
  if (firstLine) return `Everyone's in. ${firstLine}. See you there.`;
  return "Everyone's in. You're all set.";
}

const AREA: Record<FailedOn | "time", string> = {
  budget: "budget",
  dietary: "diet",
  travel: "how far people can go",
  occasion: "what kind of outing this is",
  time: "time windows",
};

export function nothingFits(areas: Array<FailedOn | "time">, occasion: Occasion = "dinner"): string {
  const unique = [...new Set(areas)];
  // "the clash is what kind of outing this is" is true but useless. When the
  // occasion is the wall, nobody has to flex -- the group has to pick something
  // else to do, which is a different ask.
  if (unique.length === 1 && unique[0] === "occasion") {
    return [
      `I could not find anywhere that works for ${occasion} within everyone's limits.`,
      `Try a different kind of outing -- text "dinner" or "lunch" and the host can send go again.`,
    ].join("\n");
  }
  const listed =
    unique.length === 0
      ? "hard limits"
      : unique.map((area) => AREA[area]).join(", ");
  return [
    `Nothing fits everyone's hard limits — the clash is ${listed}.`,
    `If anyone can flex on those, text the update, then the host can send go again.`,
  ].join("\n");
}
