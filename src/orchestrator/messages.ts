import type { Candidate, FailedOn, TimeWindow , Occasion } from "../contracts.ts";
import { mapsLink, priceTier, transitLink } from "../venues.ts";
import type { Home, Venue } from "../contracts.ts";

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

// "Thai · $$" is the pair of facts people use to decide, and it is two words
// instead of a sentence.
export function describeVenue(venue: Venue): string {
  const cuisine = venue.cuisine ? venue.cuisine[0]!.toUpperCase() + venue.cuisine.slice(1) : "";
  return [cuisine, priceTier(venue)].filter(Boolean).join(" · ");
}

// What the joiner is walking into. The organiser's opening message already
// decided the occasion, the day and often the vibe, and until now none of that
// reached anybody else -- they were asked their budget for a plan they could not
// see.
export function planIntro(plan: { occasion?: Occasion; date?: string; vibe?: string[] }): string {
  const when = whenLabel(plan.occasion, plan.date).toLowerCase();
  // The occasion is itself a taste word, so drop it from the list or the sentence
  // reads "brunch, and they're thinking brunch".
  const asks = (plan.vibe ?? []).filter((w) => w !== (plan.occasion ?? "dinner"));
  const wanted = asks.length ? ` They're thinking ${asks.slice(0, 3).join(", ")}.` : "";
  return `The plan is ${when}.${wanted}`;
}

// Everything somebody needs to actually turn up: what, when, where, what it
// costs, and how to get there from where they are.
export function settledCard(
  venue: Venue,
  opts: {
    time?: string;
    occasion?: Occasion;
    date?: string;
    tally?: string;
    from?: Home | null;
  } = {},
): string {
  const when = [whenLabel(opts.occasion, opts.date), opts.time ? `at ${opts.time}` : ""]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `Settled: ${venue.name}`,
    `${describeVenue(venue)} · ${venue.neighborhood} · about $${venue.estCostUSD}`,
    `${when}${opts.tally ? ` · ${opts.tally}` : ""}`,
    "",
    mapsLink(venue),
  ];
  if (opts.from) {
    lines.push(`Transit from ${opts.from.label}: ${transitLink(venue, opts.from)}`);
    // A neighbourhood centroid is what most people gave us, and door-to-door
    // directions need better than that -- but only say so where it is useful.
    if (!/\d/.test(opts.from.label)) {
      lines.push(`(Text me your address any time and I'll make that door-to-door.)`);
    }
  } else {
    lines.push(`Transit: ${transitLink(venue)}`);
  }
  return lines.join("\n");
}

export function planCard(
  venue: Venue,
  card: Candidate,
  occasion?: Occasion,
  date?: string,
): string {
  return [
    `${whenLabel(occasion, date)}: ${venue.name} (${venue.neighborhood})`,
    `${describeVenue(venue)} · about $${card.estCostUSD} · ${card.time} ET`,
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
  closed: "opening hours",
  time: "time windows",
};

export function nothingFits(areas: Array<FailedOn | "time">, occasion: Occasion = "dinner"): string {
  const unique = [...new Set(areas)];
  // "the clash is what kind of outing this is" is true but useless. When the
  // occasion is the wall, nobody has to flex -- the group has to pick something
  // else to do, which is a different ask.
  if (unique.length === 1 && unique[0] === "closed") {
    return [
      `Nothing that works for everyone is open then.`,
      `Text me a different time and the host can send go again.`,
    ].join("\n");
  }
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
