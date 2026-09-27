import type { RequiredSlot } from "./contracts.ts";

// A question or an aside is not an answer. Without this, "what kind of
// democracy is this" counts as a failed attempt at whatever slot is open, burns
// a retry, and two of them make the agent assume a default and move on -- so
// somebody who asked two questions ends up with a plan built on guesses.
export type MetaTurn = "help" | "why" | "who" | "options" | "confused";

const PATTERNS: Array<[MetaTurn, RegExp]> = [
  ["help", /^\s*(help|what can you do|commands|how does this work)\b/i],
  ["why", /^\s*(why|what for|what do you need|whats this for|what is this for)\b/i],
  ["who", /(who else|who is coming|whos coming|whos in|who has answered|anyone else)/i],
  ["options", /(what are (my|the) options|what are the choices|show me the options|what places)/i],
  ["confused", /^\s*(\?+|huh\??|wat\??|what\?|idk|i dont know|im confused|\p{Extended_Pictographic}+)\s*$/iu],
];

export function classifyMeta(text: string): MetaTurn | null {
  const t = text.trim();
  if (!t) return null;
  for (const [kind, re] of PATTERNS) if (re.test(t)) return kind;
  return null;
}

const LABEL: Record<RequiredSlot, string> = {
  home: "where you're coming from",
  window: "what time works",
  maxTravelMin: "how far you'll travel",
  dietary: "any food restrictions",
  budgetCapUSD: "roughly your budget",
};

// Answers the aside, then points back at what is still needed -- without
// counting as an attempt at it.
//
// `seed` rotates the wording. Two shrugs in a row ("?" then "huh") otherwise got
// byte-identical replies, which is the thing that makes a bot feel broken.
export function metaReply(
  kind: MetaTurn,
  pending: RequiredSlot | undefined,
  seed = 0,
): string {
  const need = pending ? LABEL[pending] : "";
  const back = pending ? ` Still need ${need}.` : "";
  const pick = (options: string[]) => options[Math.abs(seed) % options.length]!;

  switch (kind) {
    case "help":
      return pick([
        `I ask each of you a few things privately, then find a spot that works for everyone. Text "status" any time, or "reset" to start over.${back}`,
        `Short version: a few questions each, in private, then one plan that clears everybody's limits. "status" shows where things stand.${back}`,
      ]);
    case "why":
      return pick([
        `So I can narrow the options. Nobody else sees your answers — the others only ever see the group totals, never who said what.${back}`,
        `It's how I filter places. Your answers stay with me; the group only ever sees the combined limits.${back}`,
      ]);
    case "who":
      return pick([
        `Text "status" and I'll show you who's in and what's still outstanding.${back}`,
        `"status" gives you the full picture — who's joined and what's left.${back}`,
      ]);
    case "options":
      return pick([
        `I'll have options once everyone's answered.${back}`,
        `Nothing to show yet — I need everyone's answers first.${back}`,
      ]);
    case "confused":
      if (!pending) return pick(["Sorry, say that again?", "Didn't follow — try me again?"]);
      return pick([
        `Sorry — I just need ${need}.`,
        `My fault. Just ${need}, whenever.`,
        `Let me try again: ${need}?`,
      ]);
  }
}
