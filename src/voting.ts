import { venueById } from "./venues.ts";

// "2", "#2", "option 2", "number 2", or the venue's name. People answer a
// numbered list in all of these ways, and a vote that is not recognised is a
// dead end -- which is exactly the failure this module exists to remove.
// Apostrophes are dropped rather than turned into spaces, so "Mamoun's Falafel"
// and "mamouns falafel" are the same string by the time they are compared.
function flatten(s: string): string {
  return s
    .toLowerCase()
    .replace(/['\u2019\u02bc`]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVote(text: string, shortlist: string[]): string | null {
  const clean = flatten(text);
  if (!clean) return null;

  const numeric = clean.match(/^(?:option|number|no|#)?\s*(\d{1,2})$/);
  if (numeric?.[1]) {
    const index = Number(numeric[1]) - 1;
    return shortlist[index] ?? null;
  }

  // Name match, loose in both directions: "ess a bagel" vs "Ess-a-Bagel".
  for (const venueId of shortlist) {
    const name = venueById(venueId) ? flatten(venueById(venueId)!.name) : "";
    if (!name) continue;
    if (clean === name || (clean.length >= 4 && (name.includes(clean) || clean.includes(name)))) {
      return venueId;
    }
  }
  return null;
}

// Most votes wins. A tie falls back to shortlist order, which is best
// worst-case score first -- so a tie resolves to the option the negotiation
// already judged fairest rather than to whoever voted first.
export function tallyVotes(
  votes: Record<string, string>,
  shortlist: string[],
): { winner: string | null; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const venueId of Object.values(votes)) {
    if (shortlist.includes(venueId)) counts[venueId] = (counts[venueId] ?? 0) + 1;
  }
  let winner: string | null = null;
  let best = 0;
  for (const venueId of shortlist) {
    const n = counts[venueId] ?? 0;
    if (n > best) {
      best = n;
      winner = venueId;
    }
  }
  return { winner, counts };
}
