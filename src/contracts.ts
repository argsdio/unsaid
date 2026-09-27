// The A/B contracts. A (messaging and flow) imports this file; tonight the
// compiler is the only thing enforcing these shapes, so a field change here is a
// contract change. Numbering matches the contracts table in the build plan.

export type Confidence = "high" | "low";

// Contract 1. Extraction captures verbatim words in `raw`; src/resolve/ turns
// them into `value`. All three states are distinct: slot absent = never asked,
// value [] or 0 = "no restriction", value null with a raw = asked but not
// canonicalisable. Collapsing the last two makes the agent re-ask someone who
// already said "I eat anything".
export type Slot<T> = {
  raw: string;
  value: T | null;
  confidence: Confidence;
};

// What kind of outing this is. Everything about the app used to assume "dinner
// tonight": the 17:00 default window, a bare "7" meaning 7pm, the word
// "Tonight" on the card, and a catalogue of dinner venues. This is that
// assumption made explicit so it can be something else.
export const OCCASIONS = ["brunch", "lunch", "dinner", "drinks", "coffee"] as const;
export type Occasion = (typeof OCCASIONS)[number];

export type Coords = { lat: number; lng: number };
export type OpenPeriod = { day: number; open: number; close: number };
export type Home = Coords & { label: string };
export type TimeWindow = { start: string; end: string };

// Times that never work — class on Tuesday evenings, a shift until 7 on weekdays.
// Stable across plans, unlike the per-plan availability window. 0 = Sunday.
export type Blackout = { days: number[]; start: string; end: string };

// One stored DM. Kept per (planId, userId) so extraction can see what was
// already said, and so the reveal can show a real transcript.
export type StoredMessage = {
  at: string;
  direction: "in" | "out";
  text: string;
};

export const DIETARY_TAGS = [
  "vegetarian",
  "vegan",
  "halal",
  "kosher",
  "gluten-free",
  "dairy-free",
  "nut-free",
  "pescatarian",
  "no-pork",
  "no-shellfish",
] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];

export type Slots = {
  budgetCapUSD?: Slot<number>;
  dietary?: Slot<DietaryTag[]>;
  window?: Slot<TimeWindow>;
  home?: Slot<Home>;
  maxTravelMin?: Slot<number>;
  tags?: string[];
  namedSpots?: string[];
  // Phrases no resolver could canonicalise. Scored softly, never filtered on --
  // this is what stops "I only eat purple food" emptying the survivor set.
  unresolved?: string[];
  // How many times each slot has been asked. Drives the retry ladder: ask,
  // rephrase with an example, then assume a default rather than loop forever.
  attempts?: Partial<Record<RequiredSlot, number>>;
  // Slots the person hedged about ("$25 tops, kinda broke rn"). The negotiation
  // never asks these to flex, however much it would help the group.
  sensitive?: RequiredSlot[];
};

export const REQUIRED_SLOTS = [
  "budgetCapUSD",
  "dietary",
  "window",
  "home",
  "maxTravelMin",
] as const;
export type RequiredSlot = (typeof REQUIRED_SLOTS)[number];

// Contract 2 (A -> B -> A). B owns DM copy because it knows what is still
// missing; A owns group copy.
export type HandleDMInput = { planId: string; userId: string; text: string };
export type HandleDMResult = { slots: Slots; missing: RequiredSlot[]; reply: string };

// Contract 3 (B owns, A calls). No `hours` field: demo scope is one evening, so
// every venue is open. Consequence -- merged.window does not filter venues, it
// only tells A what time to propose.
export type Venue = {
  id: string;
  name: string;
  estCostUSD: number;
  tags: string[];
  neighborhood: string;
  lat: number;
  lng: number;
  // Which occasions this venue is plausible for. Optional so a venue added
  // without it still works -- `mealsFor` infers meals from tags as a fallback.
  meals?: Occasion[];
  // What kind of place it is, one word, for copy and for matching what somebody
  // said they felt like. `tags` stays the fuller list: it carries the dietary
  // tags filterVenues treats as hard requirements.
  cuisine?: string;
  // Everything below comes from Google Places via `npm run venues`, so it is
  // absent on a hand-written entry and code must cope with that.
  placeId?: string;
  rating?: number;
  ratingCount?: number;
  // When it is open, as minutes from midnight local, 0 = Sunday. A `close`
  // smaller than its `open` runs past midnight, which is normal for a bar.
  hours?: OpenPeriod[];
};

// One aggregate per survivor, so whose commute it is stays unlabelled.
export type Survivor = { venueId: string; longestTravelMin: number };

// A category, never a person and never a reason -- safe for the backroom screen.
export type FailedOn = "budget" | "dietary" | "travel" | "occasion" | "closed";
export type Rejection = { venueId: string; failedOn: FailedOn };

export type FilterResult = { survivors: Survivor[]; rejected: Rejection[] };

// Stays inside B. Passed to filterVenues separately so it never reaches A.
export type TravelProfile = { userId: string; home: Home | null; maxTravelMin: number | null };

// Contract 4 (B -> A). Three group-level fields, nothing per-person. Travel is
// absent by design: a commute needs home coordinates, the private data this
// contract exists to withhold. harness.ts fails if a fourth key appears.
export type MergedConstraints = {
  budgetCapUSD: number;
  requiredDietary: DietaryTag[];
  window: TimeWindow;
};

export const MERGED_KEYS = ["budgetCapUSD", "requiredDietary", "window"] as const;

// Contract 12 -- the negotiation. Objections and concessions are typed so a
// reason can cross the boundary without a name attached: the orchestrator learns
// THAT a $25 cap exists, never whose it is. There is no free-text field, because
// prose would carry identifying detail within two turns.
export type Objection =
  | { kind: "budget"; cap: number }
  | { kind: "dietary"; tag: DietaryTag }
  | { kind: "travel"; maxMin: number }
  // Neither of these is a person's objection: one means the catalogue has too
  // few places for this kind of outing, the other that nothing is open then.
  // Named so the failure message stops blaming whoever has the tightest budget.
  | { kind: "occasion"; occasion: Occasion }
  | { kind: "closed" };

// Dietary is absent on purpose. A dietary need is not a preference and is never
// asked to bend.
export type Concession =
  | { kind: "budget"; newCap: number }
  | { kind: "travel"; newMaxMin: number };

export type Position = {
  venueId: string;
  move: "accept" | "hold";
  score: number;
};

// Rounds are RoundLog so they can be appended with store.appendRound and read by
// the backroom screen without conversion.
// `merged` is returned so the caller can pick a time for the plan card without
// recomputing it -- and it is the relaxed version, after any concessions.
// A paused negotiation, persisted so it survives both the minutes a person takes
// to answer their agent and a process restart.
export type SavedNegotiation = {
  planId: string;
  round: number;
  // Relaxations agreed so far, per person. B-internal -- the orchestrator only
  // ever sees the merged result.
  relaxations: Record<string, { budget?: number; travel?: number }>;
  // Anyone already asked privately, regardless of their answer. Asking once is
  // advocacy; asking the same person three times with an escalating number is
  // pressure, which is the thing the sensitivity flag exists to prevent.
  asked: string[];
  // Carries the exact relaxation being asked about, so agreeing applies the same
  // number the person was shown.
  pendingAsk?: {
    userId: string;
    question: string;
    kind: "budget" | "travel";
    newValue: number;
  };
};

export type NegotiationResult =
  // `shortlist` is up to three venues, best first. One option is a decision
  // handed down; three is a choice, which gives somebody who disagrees with the
  // top pick something to do about it.
  | { status: "settled"; shortlist: string[]; merged: MergedConstraints; rounds: RoundLog[] }
  // Paused: one person's agent is asking them privately whether they can flex.
  | {
      status: "waiting";
      userId: string;
      question: string;
      merged: MergedConstraints;
      rounds: RoundLog[];
    }
  | {
      status: "failed";
      reason: "no-overlap" | "deadlock" | "round-cap";
      binding: Objection | null;
      merged: MergedConstraints;
      rounds: RoundLog[];
    };

// Contract 5 (A -> B). Batched: one payload per person per round.
export type Candidate = { venueId: string; time: string; estCostUSD: number };
export type CandidatePlan = { roundId: string; candidates: Candidate[] };

// Contract 6 (B -> A). No reason field (the privacy rule at the individual
// level) and no travel field (A gets the unlabelled aggregate from the filter).
// Scores must be graded: best-worst-case selection over 1.0/0.0 ties at zero and
// makes A's picker arbitrary.
export type Evaluation = {
  venueId: string;
  pass: boolean;
  score: number;
  needsMyHuman?: true;
};

// Contract 7 (A writes, B reads). B's decoupling seam -- the backroom screen can
// be built against hand-written rounds with no orchestrator and no Spectrum.
export type RoundLog = {
  planId: string;
  round: number;
  at: string;
  candidates: { venueId: string; passed: boolean; failedOn?: FailedOn; scores: number[] }[];
  // Added for the multi-round negotiation. Optional so A's existing single-round
  // writes keep type-checking unchanged.
  narration?: string;
  objections?: Objection[];
  concessions?: Concession[];
  settledOn?: string;
};

export type PlanStatus = "collecting" | "negotiating" | "proposed" | "confirmed";

// Contract 8. Ownership is split down this type, and A's join flow must not
// clobber users.profile -- that is where the ~15 seeded preferred spots live.
export type PlanDoc = {
  _id: string;
  joinCode: string; // A
  participants: string[]; // A
  status: PlanStatus; // A
  slots: Record<string, Slots>; // B
  merged?: MergedConstraints; // B
  chosen?: Candidate; // A
  // What kind of outing: brunch, dinner, drinks. Drives which venues qualify,
  // what a bare "11" means, the default window, and the copy.
  occasion?: Occasion;
  // Taste words from the message that started the plan -- "boba", "somewhere
  // nice", "cheap thai". The organiser is describing the outing for everyone, so
  // these reach every agent's scoring; without that they only ever reached the
  // organiser's own agent and could not move a worst-case ranking.
  vibe?: string[];
  // The day the plan is for, as YYYY-MM-DD. Read from the creator's first
  // message ("dinner friday?"). Without it every plan is silently today, so
  // times and blackouts resolve against the wrong day.
  date?: string;
  // The options that went out, the time proposed with them, and who picked what.
  // Stored so a reply of "2" resolves to a venue, a vote survives a restart, and
  // the settled card can say when -- `chosen` used to be declared here and never
  // written by anything, so `status` could not report the pick.
  shortlist?: string[];
  proposedTime?: string;
  votes?: Record<string, string>;
};

export type UserDoc = {
  _id: string;
  phone: string;
  // Built up across plans during onboarding and as people answer. Budget is
  // deliberately absent: it depends on the occasion (brunch vs a fancy dinner),
  // so it is asked every plan. Availability is absent for the same reason —
  // only the standing impossibilities live here, as `blackouts`.
  profile: {
    home?: Home;
    dietary?: DietaryTag[];
    blackouts?: Blackout[];
    tastes: string[];
    preferredSpots: string[];
  };
  // Which profile questions have been asked, and when onboarding finished.
  // Recorded explicitly because an empty answer ("no dietary needs") is
  // indistinguishable from an unasked one otherwise.
  askedProfile?: string[];
  onboardedAt?: string;
  activePlanId?: string;
  wishlist: string[];
};

// Contract 9 (A -> B). Writes budgetCapUSD, the field contract 1 defines. A
// second budget field is the failure mode to avoid.
export type NessieAnchor = { userId: string; budgetCapUSD: number; typicalSpendUSD: number };
