import type { Candidate, FailedOn, TimeWindow } from "../contracts.ts";
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

export function planCard(venue: Venue, card: Candidate): string {
  return [
    `Tonight: ${venue.name} (${venue.neighborhood})`,
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
  time: "time windows",
};

export function nothingFits(areas: Array<FailedOn | "time">): string {
  const unique = [...new Set(areas)];
  const listed =
    unique.length === 0
      ? "hard limits"
      : unique.map((area) => AREA[area]).join(", ");
  return [
    `Nothing fits everyone's hard limits — the clash is ${listed}.`,
    `If anyone can flex on those, text the update, then the host can send go again.`,
  ].join("\n");
}
