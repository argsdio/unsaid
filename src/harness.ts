import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Candidate, Evaluation, MergedConstraints, PlanDoc } from "./contracts.ts";
import { MERGED_KEYS, OCCASIONS } from "./contracts.ts";
import { type Participant, hasOverlap, mergeConstraints, travelProfiles } from "./aggregator.ts";
import { type RawSlots, resolveBudget, resolveDietary, resolveHome, resolveSlots } from "./resolve/index.ts";
import { scoreCandidates } from "./agent/score.ts";
import { handleDM } from "./slots.ts";
import { parseStatus, planStatus } from "./status.ts";
import { extract, extractOffline } from "./agent/extract.ts";
import { resolveBlackouts } from "./resolve/blackout.ts";
import { defaultWindow, describeWindow, resolveWindow } from "./resolve/time.ts";
import { resolveOccasion } from "./resolve/occasion.ts";
import { nothingFits, planIntro, settledCard, whenLabel } from "./orchestrator/messages.ts";
import { VENUES, filterVenues, findVenueByName, isOpenDuring, mapsLink, matchesVibe, priceTier, venueById } from "./venues.ts";
import { DEMO_PLAN_ID, DEMO_ROUNDS } from "./backroom/fixtures.ts";
import { buildState } from "./backroom/state.ts";
import { openStore } from "./db.ts";
import { routeMessage } from "./router.ts";
import { negotiate, parseAgreement, resumeNegotiation } from "./negotiation.ts";
import { parseVote, tallyVotes } from "./voting.ts";
import { resolveDate } from "./resolve/date.ts";
import { classifyMeta } from "./meta.ts";
import { isSensitive } from "./resolve/sensitivity.ts";

type FakeUser = {
  userId: string;
  tastes: string[];
  preferredSpots: string[];
  dms: RawSlots;
};

// Deliberately conflicting: the tightest budget, the only dietary requirement
// and the tightest travel cap each belong to a different person.
const USERS: FakeUser[] = [
  {
    userId: "maya",
    tastes: ["vegetarian", "noodles", "quick"],
    preferredSpots: ["superiority-burger", "xian-famous", "vanessas"],
    dms: {
      homeRaw: "im in bushwick",
      budgetRaw: "$25 tops, kinda broke rn",
      dietaryRaw: "vegetarian",
      windowRaw: "after 7",
      travelRaw: "i dont mind traveling",
      tags: ["casual"],
    },
  },
  {
    userId: "dev",
    tastes: ["pizza", "italian", "cocktails"],
    preferredSpots: ["joes-pizza", "rubirosa", "paulie-gees-slice"],
    dms: {
      homeRaw: "im right by WTC",
      budgetRaw: "anywhere from 20-45 is fine",
      dietaryRaw: "I can eat everything",
      windowRaw: "free 6 to 11",
      travelRaw: "an hour is fine",
    },
  },
  {
    userId: "priya",
    tastes: ["middle-eastern", "falafel", "vegan"],
    preferredSpots: ["taim", "mamouns", "samesa"],
    dms: {
      homeRaw: "near washington square",
      budgetRaw: "like 30",
      dietaryRaw: "not picky",
      windowRaw: "after 8",
      travelRaw: "30 min",
    },
  },
];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

function bestWorstCase(
  survivorTravel: Map<string, number>,
  perPerson: Evaluation[][],
): { venueId: string; worst: number } | null {
  const ids = [...survivorTravel.keys()];
  let best: { venueId: string; worst: number } | null = null;

  for (const venueId of ids) {
    const scores = perPerson.map(
      (evals) => evals.find((e) => e.venueId === venueId)?.score ?? 0,
    );
    const worst = Math.min(...scores);
    if (!best) {
      best = { venueId, worst };
      continue;
    }
    if (worst > best.worst) {
      best = { venueId, worst };
      continue;
    }
    // Tiebreak on the shorter longest commute -- fairness, not total travel.
    if (worst === best.worst) {
      const a = survivorTravel.get(venueId) ?? Infinity;
      const b = survivorTravel.get(best.venueId) ?? Infinity;
      if (a < b) best = { venueId, worst };
    }
  }
  return best;
}

async function main(): Promise<void> {
  const day = new Date();

  // The conversation and pipeline checks assert accumulation, selection and
  // storage logic -- not extraction quality -- so they run on the offline
  // extractor. That keeps them deterministic and turns an 84-second suite back
  // into an instant one. The Grok path gets its own checks at the end, with the
  // key restored.
  const GROK_KEY = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;

  const people: Participant[] = [];
  for (const user of USERS) {
    people.push({ userId: user.userId, slots: await resolveSlots(user.dms, {}, undefined, day) });
  }

  console.log("\nRESOLVED SLOTS");
  for (const person of people) {
    const s = person.slots;
    console.log(
      `  ${person.userId.padEnd(6)} budget=$${s.budgetCapUSD?.value} ` +
        `dietary=[${s.dietary?.value?.join(",") ?? "null"}] ` +
        `home=${s.home?.value?.label ?? "unresolved"} ` +
        `travel<=${s.maxTravelMin?.value}min ` +
        `window=${s.window?.value?.start.slice(11, 16)}-${s.window?.value?.end.slice(11, 16)}`,
    );
  }

  const merged: MergedConstraints = mergeConstraints(people, day);
  console.log("\nMERGED CONSTRAINTS (all the orchestrator ever sees)");
  console.log(`  ${JSON.stringify(merged)}`);
  console.log(`  shared window: ${hasOverlap(merged.window) ? "yes" : "NO OVERLAP"}`);

  const profiles = travelProfiles(people);
  const { survivors, rejected } = filterVenues(VENUES, merged, profiles);
  const byCategory = rejected.reduce<Record<string, number>>((acc, r) => {
    acc[r.failedOn] = (acc[r.failedOn] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nFILTER  ${survivors.length} of ${VENUES.length} survive`);
  console.log(`  rejected: ${JSON.stringify(byCategory)}`);

  const perPerson: Evaluation[][] = [];
  for (const [i, person] of people.entries()) {
    const user = USERS[i];
    if (!user) continue;
    perPerson.push(
      await scoreCandidates(survivors, {
        slots: person.slots,
        tastes: user.tastes,
        preferredSpots: user.preferredSpots,
      }),
    );
  }

  console.log("\nSCORES (worst-case per venue drives the pick)");
  const travel = new Map(survivors.map((s) => [s.venueId, s.longestTravelMin]));
  for (const survivor of survivors) {
    const scores = perPerson.map(
      (evals) => evals.find((e) => e.venueId === survivor.venueId)?.score ?? 0,
    );
    const name = venueById(survivor.venueId)?.name ?? survivor.venueId;
    console.log(
      `  ${name.padEnd(26)} ${scores.map((s) => s.toFixed(2)).join("  ")}   worst=${Math.min(...scores).toFixed(2)}  longest=${survivor.longestTravelMin}min`,
    );
  }

  const winner = bestWorstCase(travel, perPerson);
  if (winner) {
    const venue = venueById(winner.venueId);
    const chosen: Candidate = {
      venueId: winner.venueId,
      time: merged.window.start,
      estCostUSD: venue?.estCostUSD ?? 0,
    };
    console.log(
      `\nPLAN  ${venue?.name} (${venue?.neighborhood}) $${chosen.estCostUSD} at ${chosen.time.slice(11, 16)} ` +
        `-- worst-case score ${winner.worst.toFixed(2)}, longest commute ${travel.get(winner.venueId)}min`,
    );
  } else {
    console.log("\nPLAN  none -- nothing passed, this is where the flex whisper fires");
  }

  console.log("\nASSERTIONS");
  check("a plan was produced", winner !== null);
  // A band, not a number: the catalogue is now Places-sourced and grows whenever
  // `npm run venues` runs. Zero means the filter is broken; everything means it
  // is not filtering.
  check(
    "the three demo profiles leave a usable shortlist to choose from",
    survivors.length >= 6 && survivors.length <= VENUES.length * 0.25,
    `(${survivors.length} of ${VENUES.length})`,
  );

  const keys = Object.keys(merged).sort().join(",");
  check(
    "orchestrator sees exactly three keys",
    keys === [...MERGED_KEYS].sort().join(","),
    keys,
  );

  // The safety property: an uncanonicalisable phrase must not filter anything.
  const withNonsense = people.map((p, i) =>
    i === 0
      ? { ...p, slots: { ...p.slots, unresolved: ["i only eat purple food"] } }
      : p,
  );
  const nonsenseMerged = mergeConstraints(withNonsense, day);
  const nonsenseResult = filterVenues(VENUES, nonsenseMerged, travelProfiles(withNonsense));
  check(
    "unresolvable dietary text leaves survivors unchanged",
    nonsenseResult.survivors.length === survivors.length,
    `(${nonsenseResult.survivors.length} vs ${survivors.length})`,
  );

  const purple = resolveDietary("i only eat purple food");
  check("that phrase resolves to no hard tags", purple.slot.value === null && purple.unresolved.length > 0);

  const everything = resolveDietary("I can eat everything");
  check("'I can eat everything' is [] not null", Array.isArray(everything.slot.value) && everything.slot.value.length === 0);
  const notPicky = resolveDietary("not picky");
  check("'not picky' is [] not null", Array.isArray(notPicky.slot.value) && notPicky.slot.value.length === 0);
  const nuts = resolveDietary("i cant eat anything with nuts");
  check("'anything with nuts' is nut-free, not 'no restrictions'", nuts.slot.value?.includes("nut-free") === true);

  const wtc = await resolveHome("im right by WTC");
  check("'WTC' resolves", wtc.value !== null, wtc.value?.label ?? "");
  const wsp = await resolveHome("near washington square");
  check("'washington square' resolves", wsp.value !== null, wsp.value?.label ?? "");
  const addrOffline = await resolveHome("133 W 3rd St");
  check("a street address is null with no geocoder", addrOffline.value === null);
  const addrOnline = await resolveHome("133 W 3rd St", async () => ({ lat: 40.7302, lng: -74.0005 }));
  check("the same address resolves through the geocoder", addrOnline.value !== null);

  check("'cheap' resolves to a number", typeof resolveBudget("cheap").value === "number");
  check("'$25 tops' resolves to 25", resolveBudget("$25 tops, kinda broke rn").value === 25);
  check(
    "a small explicit amount beats a word like 'broke'",
    resolveBudget("$4 max, kinda broke rn").value === 4 && resolveBudget("$6").value === 6,
    `(${resolveBudget("$4 max, kinda broke rn").value})`,
  );
  check("but a bare number that small is not a budget", resolveBudget("table for 4").value === null);

  // Everything below runs against the REAL store — Atlas when MONGODB_URI is
  // set — so the Mongo implementation is actually exercised. Ids are scoped to
  // this run so repeated runs never collide, and torn down at the end.
  const RUN = Date.now().toString(36);
  const P = (name: string) => `p-${RUN}-${name}`;
  const U = (name: string) => `u-${RUN}-${name}`;
  const live = await openStore();
  const usedPlans: string[] = [];
  const usedUsers: string[] = [];

  // handleDM drives onboarding first, then plan slot-filling.
  const say = async (userId: string, planId: string, text: string) =>
    handleDM({ planId, userId, text }, live);

  console.log("\nONBOARDING A NEW USER");
  const onboarding = [
    "dinner friday?",
    "bushwick",
    "vegetarian",
    "class on tuesday nights",
    "joe's pizza",
  ];
  let turn = await say(U("maya"), P("a"), onboarding[0]!);
  console.log(`  "${onboarding[0]}"`.padEnd(30) + `-> ${turn.reply}`);
  check("onboarding starts with location, not budget", /where do you usually/i.test(turn.reply));
  for (const text of onboarding.slice(1)) {
    turn = await say(U("maya"), P("a"), text);
    console.log(`  "${text}"`.padEnd(30) + `-> ${turn.reply}`);
  }

  const profile = (await live.getUser(U("maya")))?.profile;
  check("profile learned home", profile?.home?.label.toLowerCase().includes("bushwick") === true);
  check("profile learned dietary", profile?.dietary?.includes("vegetarian") === true);
  check("profile learned a Tuesday blackout", profile?.blackouts?.[0]?.days.includes(2) === true);
  check("a named favourite became a venue id", profile?.preferredSpots.includes("joes-pizza") === true);
  check("onboarding completed", (await live.getUser(U("maya")))?.onboardedAt !== undefined);
  check("after onboarding it asks about time, not location", /what time works/i.test(turn.reply));
  check("and it says what it reused", /from your profile/i.test(turn.reply));

  console.log("\nSAME USER, SECOND PLAN (profile already known)");
  let second = await say(U("maya"), P("b"), "dinner sunday?");
  console.log(`  "dinner sunday?"`.padEnd(30) + `-> ${second.reply}`);
  check(
    "a returning user is not asked for location or diet again",
    !second.missing.includes("home") && !second.missing.includes("dietary"),
  );
  check("but budget is still asked every plan", second.missing.includes("budgetCapUSD"));

  for (const text of ["after 7", "i dont mind traveling", "$25 tops"]) {
    second = await say(U("maya"), P("b"), text);
    console.log(`  "${text}"`.padEnd(30) + `-> ${second.reply}`);
  }
  check("second plan completes in three answers", second.missing.length === 0);
  check("budget resolved to 25", second.slots.budgetCapUSD?.value === 25);
  check("budget stayed out of the profile", !("defaultBudgetUSD" in ((await live.getUser(U("maya")))?.profile ?? {})));

  const transcript = await live.listMessages(P("b"), U("maya"));
  check("messages are stored both directions", transcript.some((m) => m.direction === "in") && transcript.some((m) => m.direction === "out"));
  check("transcript length matches the exchange", transcript.length === 8, `(${transcript.length})`);

  // A bare reply lands on the slot that was just asked about.
  check(
    "'30' is read as travel time when travel was asked",
    extractOffline("30", "maxTravelMin").travelRaw === "30" &&
      extractOffline("30", "maxTravelMin").budgetRaw === undefined,
  );
  check(
    "'30' is read as budget when budget was asked",
    extractOffline("30", "budgetCapUSD").budgetRaw === "30" &&
      extractOffline("30", "budgetCapUSD").travelRaw === undefined,
  );

  const tuesday = resolveBlackouts("class on tuesday nights and work until 7 on weekdays");
  check("two blackouts parsed from one sentence", tuesday.length === 2, `(${tuesday.length})`);
  usedPlans.push(P("a"), P("b"));
  usedUsers.push(U("maya"));

  // The repeated-question bug: four defects that together made two slots loop
  // forever. Each gets its own assertion.
  check(
    "a bare clock resolves as a time",
    ["7pm", "8ish", "around 7:30", "7", "at 8"].every((t) => resolveWindow(t).value !== null),
  );
  check(
    "non-times are still not times",
    ["cheap", "vegetarian", "bushwick", "30 min"].every((t) => resolveWindow(t).value === null),
  );

  // The catalogue is hand-written, so it gets validated like input rather than
  // trusted like code. Each of these has already caught a real typo.
  // Scoring hundreds of survivors must stay bounded, and every survivor must
  // still come back with a score whether or not a model saw it.
  const manySurvivors = VENUES.slice(0, 120).map((v) => ({ venueId: v.id, longestTravelMin: 20 }));
  const scoredMany = await scoreCandidates(manySurvivors, { slots: {}, tastes: ["italian"], preferredSpots: [] });
  check(
    "every survivor gets a score, however many there are",
    scoredMany.length === manySurvivors.length && scoredMany.every((e) => e.score > 0),
    `(${scoredMany.length})`,
  );
  check(
    "a favourite is matched by name, and an ordinary sentence is not",
    findVenueByName("i love joe's pizza")?.id === "joes-pizza" &&
      findVenueByName("katz's")?.id === "katzs" &&
      findVenueByName("my fav is the bar") === undefined &&
      findVenueByName("grabbing a bite to eat") === undefined &&
      findVenueByName("posting about it") === undefined,
    [findVenueByName("my fav is the bar")?.name, findVenueByName("grabbing a bite to eat")?.name]
      .filter(Boolean).join(", "),
  );
  check(
    "every venue has a unique id and name",
    new Set(VENUES.map((v) => v.id)).size === VENUES.length &&
      new Set(VENUES.map((v) => v.name)).size === VENUES.length,
  );
  check(
    "every venue says what kind of place it is and what it costs",
    VENUES.every((v) => v.cuisine && v.estCostUSD > 0 && v.tags.length > 0),
    VENUES.filter((v) => !v.cuisine).map((v) => v.name).join(", "),
  );
  check(
    "every venue is plausible for at least one occasion, and only real ones",
    VENUES.every((v) => (v.meals ?? []).length > 0 && v.meals!.every((m) => OCCASIONS.includes(m))),
  );
  check(
    "every venue is in New York",
    VENUES.every((v) => v.lat > 40.4 && v.lat < 41.0 && v.lng > -74.3 && v.lng < -73.6),
  );
  // A drinks outing means a bar. Restaurants carrying a `cocktails` or `wine`
  // tag used to qualify, so a $95 tasting menu was a candidate for going out
  // for a drink. A real cocktail lounge can be expensive, so this tests what
  // kind of place it is rather than what it costs.
  const forDrinks = VENUES.filter((v) => v.meals?.includes("drinks"));
  const barish = (v: (typeof VENUES)[number]) =>
    ["cocktails", "wine", "beer"].includes(v.cuisine ?? "") ||
    v.tags.some((t) => ["bar", "brewery", "rooftop"].includes(t));
  check(
    "only bars are offered as a place for drinks",
    forDrinks.length > 0 && forDrinks.every(barish),
    forDrinks.filter((v) => !barish(v)).map((v) => v.name).join(", "),
  );
  check(
    "the price tier tracks the price",
    priceTier({ ...VENUES[0]!, estCostUSD: 9 }) === "$" &&
      priceTier({ ...VENUES[0]!, estCostUSD: 28 }) === "$$" &&
      priceTier({ ...VENUES[0]!, estCostUSD: 95 }) === "$$$$",
  );
  check(
    "the opening message's taste words survive",
    extractOffline("somewhere nice for dinner friday").tags?.includes("nice") === true &&
      extractOffline("cheap thai near me").tags?.includes("thai") === true &&
      extractOffline("cheap thai near me").tags?.includes("cheap") === true,
    JSON.stringify(extractOffline("somewhere nice for dinner friday").tags),
  );
  check(
    "a plain answer picks up no taste words",
    (extractOffline("east village").tags ?? []).length === 0 &&
      (extractOffline("i eat everything").tags ?? []).length === 0,
  );
  check(
    "'somewhere cheap' and 'somewhere nice' point at different places",
    matchesVibe({ ...VENUES[0]!, estCostUSD: 9 }, ["somewhere cheap"]) &&
      !matchesVibe({ ...VENUES[0]!, estCostUSD: 9 }, ["somewhere nice"]) &&
      matchesVibe({ ...VENUES[0]!, estCostUSD: 45 }, ["somewhere nice"]),
  );

  // The occasion. Everything used to assume dinner tonight: the 17:00 default,
  // a bare hour meaning PM, the word "Tonight", and a dinner-only catalogue.
  check(
    "the occasion is read off the opening message",
    resolveOccasion("sunday brunch?") === "brunch" &&
      resolveOccasion("drinks friday") === "drinks" &&
      resolveOccasion("coffee tmrw?") === "coffee" &&
      resolveOccasion("lunch monday") === "lunch",
  );
  check("an opening message with no occasion is dinner", resolveOccasion("are we doing something friday") === "dinner");
  check(
    "naming the outing beats describing when it is",
    resolveOccasion("coffee tomorrow morning") === "coffee" &&
      resolveOccasion("late lunch friday") === "lunch" &&
      resolveOccasion("dinner tonight") === "dinner" &&
      resolveOccasion("drinks tonight") === "drinks",
    resolveOccasion("coffee tomorrow morning"),
  );
  check(
    "and a time of day still counts when nothing is named",
    resolveOccasion("something saturday morning") === "brunch" &&
      resolveOccasion("wanna hang out sunday") === "coffee" &&
      resolveOccasion("im hungry, food friday?") === "dinner",
  );
  check(
    "boba, matcha and dessert are a coffee outing",
    ["boba tmrw?", "bubble tea after class", "matcha run", "dessert somewhere"].every(
      (t) => resolveOccasion(t) === "coffee",
    ),
  );
  // A real run: one person said "10 am - 2pm" and the other said "10 am", and
  // both were told "10am-2pm - got it". The stored window is right -- free from
  // 10 until brunch stops being brunch -- but echoing the pair back says they
  // gave a range they never gave.
  const brunchDay = new Date("2026-10-04T12:00:00");
  const saidAt = resolveWindow("10 am", brunchDay, "brunch");
  const saidRange = resolveWindow("10 am - 2pm", brunchDay, "brunch");
  check(
    "an open-ended time is not echoed back as somebody else's range",
    describeWindow("10 am", saidAt.value!) === "from 10am" &&
      describeWindow("10 am - 2pm", saidRange.value!) === "10am–2pm",
    `${describeWindow("10 am", saidAt.value!)} vs ${describeWindow("10 am - 2pm", saidRange.value!)}`,
  );
  check(
    "each way of saying a time is echoed the way it was said",
    describeWindow("after 7", resolveWindow("after 7").value!) === "from 7pm" &&
      describeWindow("before 9", resolveWindow("before 9").value!) === "before 9pm" &&
      describeWindow("6 to 10", resolveWindow("6 to 10").value!) === "6pm–10pm" &&
      describeWindow("8pm", resolveWindow("8pm").value!) === "from 8pm",
  );
  check(
    "and the two answers still intersect to the same window",
    saidAt.value!.start === saidRange.value!.start && saidAt.value!.end === saidRange.value!.end,
  );

  check(
    "a bare '11' is 11am for brunch and 11pm for drinks",
    resolveWindow("11", new Date(), "brunch").value?.start.slice(11, 16) === "11:00" &&
      resolveWindow("11", new Date(), "drinks").value?.start.slice(11, 16) === "23:00",
  );
  check(
    "the default window follows the occasion",
    defaultWindow(new Date(), "brunch").start.slice(11, 16) === "10:00" &&
      defaultWindow(new Date(), "dinner").start.slice(11, 16) === "17:00",
  );
  const brunchMerged: MergedConstraints = {
    budgetCapUSD: 200,
    requiredDietary: [],
    window: defaultWindow(new Date(), "brunch"),
  };
  const openProfiles = travelProfiles([{ userId: "anyone", slots: {} }]);
  const atBrunch = filterVenues(VENUES, brunchMerged, openProfiles, "brunch");
  // The property, not a count: this venue is for dinner only, so at brunch it is
  // rejected, and rejected on the occasion rather than blamed on somebody's cap.
  const dinnerOnly = VENUES.find((v) => v.meals?.length === 1 && v.meals[0] === "dinner");
  check(
    "a dinner-only venue is rejected at brunch, and on occasion not budget",
    dinnerOnly !== undefined &&
      atBrunch.rejected.find((r) => r.venueId === dinnerOnly.id)?.failedOn === "occasion",
    dinnerOnly?.name ?? "no dinner-only venue in the catalogue",
  );

  // Opening hours. A fifth of the catalogue is hand-written with no hours at
  // all, so unknown has to mean allowed or the demo silently shrinks to whatever
  // Google matched.
  const sunday = "2026-10-04";
  const brunchWindow = { start: `${sunday}T11:00:00`, end: `${sunday}T13:00:00` };
  const lateWindow = { start: `${sunday}T01:00:00`, end: `${sunday}T02:00:00` };
  const dinnerHours = { ...VENUES[0]!, hours: [{ day: 0, open: 17 * 60, close: 23 * 60 }] };
  const allDay = { ...VENUES[0]!, hours: [{ day: 0, open: 8 * 60, close: 22 * 60 }] };
  const lateBar = { ...VENUES[0]!, hours: [{ day: 6, open: 19 * 60, close: 3 * 60 }] };
  check(
    "a place that opens at five is not a brunch option",
    !isOpenDuring(dinnerHours, brunchWindow) && isOpenDuring(allDay, brunchWindow),
  );
  check("a venue with no hours is allowed, not assumed closed", isOpenDuring(VENUES[0]!, brunchWindow));
  check(
    "a bar open till three is open at one in the morning",
    isOpenDuring(lateBar, lateWindow),
  );
  check(
    "closing time is a rejection of its own, not a budget problem",
    filterVenues([dinnerHours], { ...brunchMerged, window: brunchWindow }, openProfiles, dinnerHours.meals![0]!)
      .rejected[0]?.failedOn === "closed",
  );
  check(
    "and it is reported as the time, with nobody asked to flex",
    /open then/i.test(nothingFits(["closed"])) && !/budget/i.test(nothingFits(["closed"])),
  );
  check(
    "every occasion still has somewhere to go",
    OCCASIONS.every((o) => filterVenues(VENUES, brunchMerged, openProfiles, o).survivors.length > 0),
    OCCASIONS.map((o) => `${o}:${filterVenues(VENUES, brunchMerged, openProfiles, o).survivors.length}`).join(" "),
  );
  // A Sunday brunch card that says "Tonight" is the visible half of this bug.
  check(
    "tomorrow is spelt several ways",
    ["tomorrow", "tmrw", "tmr"].every(
      (w) => resolveDate(`coffee ${w}?`, new Date("2026-09-27T12:00:00"))?.getDate() === 28,
    ),
  );
  check(
    "a thin catalogue is not reported as somebody's budget",
    /different kind of outing/i.test(nothingFits(["occasion"], "coffee")) &&
      !/flex/i.test(nothingFits(["occasion"], "coffee")),
  );
  check(
    "other failures still name a constraint to flex",
    /flex/i.test(nothingFits(["budget"])) && /diet/i.test(nothingFits(["dietary"])),
  );
  const someVenue = VENUES.find((v) => v.placeId) ?? VENUES[0]!;
  check(
    "the plan intro names the outing and what was asked for",
    /brunch/i.test(planIntro({ occasion: "brunch", date: "2026-10-04", vibe: ["brunch", "boba"] })) &&
      /boba/i.test(planIntro({ occasion: "brunch", date: "2026-10-04", vibe: ["brunch", "boba"] })),
    planIntro({ occasion: "brunch", date: "2026-10-04", vibe: ["brunch", "boba"] }),
  );
  check(
    "a precise address gets no nudge to send one",
    /door-to-door/.test(
      settledCard(someVenue, { from: { lat: 40.73, lng: -73.99, label: "East Village" } }),
    ) &&
      !/door-to-door/.test(
        settledCard(someVenue, { from: { lat: 40.73, lng: -73.99, label: "250 Mercer St" } }),
      ),
  );
  check(
    "a venue with no placeId still gets a usable map link",
    mapsLink({ ...someVenue, placeId: undefined }).includes("maps/search"),
  );

  check(
    "the card names the occasion, not the time of day it isn't",
    whenLabel("brunch", "2026-10-04") === "Sunday brunch" && whenLabel("dinner", "2026-10-02") === "Friday dinner",
    whenLabel("brunch", "2026-10-04"),
  );
  check(
    "a bare number does not set a time when budget was asked",
    extractOffline("8", "budgetCapUSD").windowRaw === undefined &&
      extractOffline("8", "budgetCapUSD").budgetRaw === "8",
  );
  check(
    "answering the home question always attempts home",
    (await extract("60th and lex", { expecting: "home" })).homeRaw === "60th and lex",
  );

  // The escalation ladder: never the same string twice, and never a dead end.
  const ladderStore = await openStore({ memory: true });
  await ladderStore.upsertUser({
    _id: "ladder", phone: "ladder", profile: { tastes: [], preferredSpots: [] },
    onboardedAt: "now", askedProfile: [], wishlist: [],
  });
  const ask = async (text: string) =>
    (await handleDM({ planId: "lp", userId: "ladder", text }, ladderStore)).reply;
  const ask1 = await ask("dinner friday?");
  const ask2 = await ask("qqqq zzzz");
  const ask3 = await ask("qqqq zzzz");
  // Property, not copy: three consecutive failures must never repeat a string.
  check(
    "no two consecutive asks are identical",
    ask1 !== ask2 && ask2 !== ask3 && ask1 !== ask3,
  );
  check("the third ask stops asking and assumes a default", ask3.includes("Manhattan"));
  const laddered = await ladderStore.getSlots("lp", "ladder");
  check("the assumed value is marked low confidence", laddered.home?.confidence === "low");
  check("attempts are tracked per slot", (laddered.attempts?.home ?? 0) >= 3);

  // Acknowledgement, which makes a misread visible in the next turn.
  const ackStore = await openStore({ memory: true });
  await ackStore.upsertUser({
    _id: "ack", phone: "ack", profile: { tastes: [], preferredSpots: [] },
    onboardedAt: "now", askedProfile: [], wishlist: [],
  });
  await handleDM({ planId: "ap", userId: "ack", text: "dinner friday?" }, ackStore);
  const acked = await handleDM({ planId: "ap", userId: "ack", text: "bushwick" }, ackStore);
  check("the reply echoes what it understood", acked.reply.startsWith("Bushwick"), acked.reply.slice(0, 40));
  await ladderStore.close();
  await ackStore.close();

  // A budget must not be read out of a time or a duration. "after 7" gave 7,
  // which tripped the $8 floor and silently returned null, so a message naming
  // three things only filled two.
  const budgetCases: Array<[string, number | null]> = [
    ["I can eat after 7, an hour away, $30", 30],
    ["after 7, 30 min away, 25", 25],
    ["40 bucks", 40],
    ["anywhere from 20-45 is fine", 45],
    ["after 7", null],
    ["30 min", null],
    ["7pm works", null],
  ];
  const wrongBudgets = budgetCases.filter(([input, want]) => resolveBudget(input).value !== want);
  check(
    "budget is not read out of a time or a duration",
    wrongBudgets.length === 0,
    wrongBudgets.map(([i]) => JSON.stringify(i)).join(" "),
  );

  const multiStore = await openStore({ memory: true });
  await multiStore.upsertUser({
    _id: "multi", phone: "multi",
    profile: { home: { lat: 40.69, lng: -73.92, label: "Bushwick" }, tastes: [], preferredSpots: [] },
    onboardedAt: "now", wishlist: [],
  });
  await handleDM({ planId: "mp", userId: "multi", text: "dinner friday?" }, multiStore);
  const triple = await handleDM(
    { planId: "mp", userId: "multi", text: "I can eat after 7, an hour away, $30" },
    multiStore,
  );
  check(
    "one message naming time, travel and budget fills all three",
    triple.slots.window?.value !== null &&
      triple.slots.maxTravelMin?.value === 60 &&
      triple.slots.budgetCapUSD?.value === 30,
    `missing: [${triple.missing.join(", ")}]`,
  );
  await multiStore.close();

  // The negotiation, layers 1-3: rounds, unattributed objections, and agents
  // deciding their own movement from the sensitivity signal.
  const negStore = await openStore({ memory: true });
  const asPeople = async (rows: Array<[string, Record<string, string>]>) => {
    const out: Participant[] = [];
    for (const [userId, dms] of rows) {
      await negStore.upsertUser({
        _id: userId, phone: userId,
        profile: { tastes: [], preferredSpots: [] }, onboardedAt: "now", wishlist: [],
      });
      out.push({ userId, slots: await resolveSlots(dms, {}, undefined, day) });
    }
    return out;
  };

  check(
    "hedging is detected, plain statements are not",
    isSensitive("$25 tops, kinda broke rn") && isSensitive("$15 max") && !isSensitive("$25") && !isSensitive("like 30"),
  );

  const hedged = await asPeople([
    ["h1", { homeRaw: "east village", budgetRaw: "$12 tops, kinda broke rn", dietaryRaw: "vegetarian", windowRaw: "after 7", travelRaw: "20 min" }],
    ["h2", { homeRaw: "harlem", budgetRaw: "$60", dietaryRaw: "i eat everything", windowRaw: "after 7", travelRaw: "20 min" }],
  ]);
  check(
    "the hedged slot is flagged on the person who hedged",
    hedged[0]?.slots.sensitive?.includes("budgetCapUSD") === true &&
      hedged[1]?.slots.sensitive?.includes("budgetCapUSD") !== true,
  );

  const hedgedRun = await negotiate(negStore, "neg-h", hedged, day);
  const budgetConcessions = hedgedRun.rounds.flatMap((r) =>
    (r.concessions ?? []).filter((c) => c.kind === "budget"),
  );
  check(
    "a hedged budget is never asked to flex",
    budgetConcessions.length === 0,
    JSON.stringify(budgetConcessions),
  );
  check("so it relaxes something else instead", hedgedRun.rounds.some((r) => (r.concessions ?? []).length > 0));
  check("and still reaches an answer", hedgedRun.status === "settled");

  // Privacy: an objection names a constraint, never a person.
  const allMoves = hedgedRun.rounds.flatMap((r) => [...(r.objections ?? []), ...(r.concessions ?? [])]);
  check(
    "no objection or concession carries an identity",
    allMoves.every((m) => !("agent" in m) && !("userId" in m)),
  );

  // Layer 4. The hedged person's cap is the only thing standing between the group
  // and somewhere to go, so they get asked privately -- once -- rather than
  // pushed silently or given up on. Same neighbourhood and no dietary needs, so
  // money is unambiguously the wall.
  const stuck = await asPeople([
    ["s1", { homeRaw: "east village", budgetRaw: "$5 tops, kinda broke rn", dietaryRaw: "i eat everything", windowRaw: "after 7", travelRaw: "1 hr" }],
    ["s2", { homeRaw: "east village", budgetRaw: "$60", dietaryRaw: "i eat everything", windowRaw: "after 7", travelRaw: "1 hr" }],
  ]);
  const stuckRun = await negotiate(negStore, "neg-s", stuck, day);
  check("nobody willing means somebody gets asked privately", stuckRun.status === "waiting");
  check(
    "the question offers an easy way out",
    stuckRun.status === "waiting" && /fine to say no/i.test(stuckRun.question),
  );
  const pausedState = await negStore.getNegotiation("neg-s");
  check(
    "the pause is persisted with the exact number offered",
    typeof pausedState?.pendingAsk?.newValue === "number" && pausedState.round >= 1,
  );

  // Follow both chains to termination, tracking who gets asked.
  const chase = async (planId: string, people: Participant[], answer: string) => {
    let r = await negotiate(negStore, planId, people, day);
    const askedOf: string[] = [];
    for (let i = 0; r.status === "waiting" && i < 8; i++) {
      askedOf.push(r.userId);
      r = await resumeNegotiation(negStore, planId, people, answer, day);
    }
    return { result: r, askedOf };
  };

  const declined = await chase("neg-no", stuck, "sorry, cant");
  check(
    "everyone declining ends in an honest deadlock",
    declined.result.status === "failed" && declined.result.reason === "deadlock",
  );
  check(
    "and nobody is asked twice, however much it would help",
    new Set(declined.askedOf).size === declined.askedOf.length && declined.askedOf.length > 0,
  );

  // What the organiser asked for has to reach the pick. Under worst-case ranking
  // alone it could not: only one person said "boba", so their preference was
  // never the minimum and never moved anything.
  const bobaPlan = "neg-vibe";
  await negStore.setOccasion(bobaPlan, "coffee");
  await negStore.setVibe(bobaPlan, ["boba"]);
  const bobaPeople = await asPeople([
    ["v1", { homeRaw: "east village", budgetRaw: "$15", dietaryRaw: "i eat everything", windowRaw: "4pm", travelRaw: "30 min" }],
    ["v2", { homeRaw: "east village", budgetRaw: "$15", dietaryRaw: "i eat everything", windowRaw: "4pm", travelRaw: "30 min" }],
  ]);
  const bobaRun = await negotiate(negStore, bobaPlan, bobaPeople, day);
  const bobaTop = bobaRun.status === "settled" ? venueById(bobaRun.shortlist[0]!) : undefined;
  check(
    "asking for boba gets boba, not just any cheap cafe",
    bobaTop !== undefined && (bobaTop.cuisine === "boba" || bobaTop.tags.includes("boba")),
    bobaTop ? `${bobaTop.name} (${bobaTop.cuisine})` : bobaRun.status,
  );

  // Nobody is interrupted for nothing. No venue in the catalogue is both kosher
  // and vegan, and no amount of money or travel changes that, so this fails
  // without asking anyone to flex anything -- the previous version burned all
  // three rounds on travel steps that admitted nothing and then asked somebody
  // to spend more. (It used to use vegan and halal, which the Places catalogue
  // can now satisfy: Mamoun's is both.)
  const unsatisfiable = await asPeople([
    ["u1", { homeRaw: "east village", budgetRaw: "$40", dietaryRaw: "vegan", windowRaw: "after 7", travelRaw: "1 hr" }],
    ["u2", { homeRaw: "east village", budgetRaw: "$40", dietaryRaw: "kosher", windowRaw: "after 7", travelRaw: "1 hr" }],
  ]);
  const unsatisfiableRun = await negotiate(negStore, "neg-u", unsatisfiable, day);
  check(
    "an unsatisfiable diet fails without asking anybody to flex",
    unsatisfiableRun.status === "failed" &&
      unsatisfiableRun.rounds.every((r) => (r.concessions ?? []).length === 0),
    unsatisfiableRun.status === "failed" ? JSON.stringify(unsatisfiableRun.binding) : unsatisfiableRun.status,
  );
  check(
    "and it says so in one round rather than three",
    unsatisfiableRun.rounds.length === 1,
    `(${unsatisfiableRun.rounds.length})`,
  );

  // A group whose only wall is money, so agreeing can actually help. `stuck`
  // cannot be rescued by any answer: it needs both vegan and halal, and dietary
  // never bends.
  const whisperable = await asPeople([
    ["y1", { homeRaw: "east village", budgetRaw: "$8 tops, kinda broke rn", dietaryRaw: "vegetarian", windowRaw: "after 7", travelRaw: "20 min max" }],
    ["y2", { homeRaw: "west village", budgetRaw: "$50", dietaryRaw: "i eat everything", windowRaw: "after 7", travelRaw: "20 min max" }],
  ]);
  const agreedRun = await chase("neg-yes", whisperable, "yeah ok");
  check("somebody agreeing reaches an answer", agreedRun.result.status === "settled");
  check(
    "the paused state is cleared once it finishes",
    (await negStore.getNegotiation("neg-yes")) === null,
  );
  check(
    "a settled plan offers up to three options, not one",
    agreedRun.result.status === "settled" &&
      agreedRun.result.shortlist.length >= 1 &&
      agreedRun.result.shortlist.length <= 3,
    agreedRun.result.status === "settled" ? `(${agreedRun.result.shortlist.length})` : "",
  );
  check(
    "yes and no are both read correctly",
    parseAgreement("yeah ok") === true && parseAgreement("sorry, cant") === false && parseAgreement("hmm") === null,
  );

  const easy = await asPeople([
    ["e1", { homeRaw: "east village", budgetRaw: "$14", dietaryRaw: "vegetarian", windowRaw: "after 7", travelRaw: "30 min" }],
    ["e2", { homeRaw: "west village", budgetRaw: "$25", dietaryRaw: "i eat everything", windowRaw: "after 7", travelRaw: "30 min" }],
  ]);
  const easyRun = await negotiate(negStore, "neg-e", easy, day);
  check("a workable group settles", easyRun.status === "settled");
  check(
    "and its shortlist is capped at three",
    easyRun.status === "settled" && easyRun.shortlist.length <= 3,
  );
  check("rounds are capped at three", easyRun.rounds.length <= 3, `(${easyRun.rounds.length})`);
  check(
    "every round explains itself",
    easyRun.rounds.every((r) => (r.narration ?? "").length > 20 && (r.narration ?? "").startsWith("Round")),
  );
  // The rounds must append with store.appendRound and read back through the
  // screen's own state builder -- that is A's entire integration.
  for (const round of easyRun.rounds) await negStore.appendRound(round);
  const negState = await buildState(negStore, "neg-e");
  check("negotiation rounds append and read back", negState.rounds.length === easyRun.rounds.length);
  check(
    "and the narration survives the round trip to the screen",
    negState.rounds.every((r) => (r.narration ?? "").startsWith("Round")),
  );
  check(
    "candidate rows keep their scores, so the screen still draws bars",
    negState.rounds[0]?.candidates.some((c) => c.passed || c.scores.length > 0) === true,
  );

  await negStore.close();

  // The blocker reported must be the one that is actually blocking. Budget is
  // checked first inside filterVenues, so it hogs the rejection count even when
  // an unsatisfiable dietary set is the real wall.
  const impossible = await asPeople([
    ["i1", { homeRaw: "east village", budgetRaw: "$25 tops", dietaryRaw: "vegetarian", windowRaw: "7pm", travelRaw: "1 hr" }],
    ["i2", { homeRaw: "williamsburg", budgetRaw: "like 40", dietaryRaw: "no nuts", windowRaw: "after 7", travelRaw: "45 min" }],
  ]);
  const impossibleRun = await negotiate(negStore, "neg-imp", impossible, day);
  check(
    "an unsatisfiable diet is named as the blocker, not the budget",
    impossibleRun.status === "failed" && impossibleRun.binding?.kind === "dietary",
    impossibleRun.status === "failed" ? JSON.stringify(impossibleRun.binding) : "",
  );

  // Once somebody has answered everything, later messages must not loop one line
  // -- and after a failed `go` that line also claimed work was happening.
  const doneStore = await openStore({ memory: true });
  await doneStore.createPlan({
    _id: "done", joinCode: "DN01", participants: ["d1", "d2"], status: "collecting", slots: {},
  });
  for (const u of ["d1", "d2"]) {
    await doneStore.upsertUser({
      _id: u, phone: u, profile: { tastes: [], preferredSpots: [] }, onboardedAt: "now", wishlist: [],
    });
    for (const text of ["dinner?", "east village", "7pm", "1 hr", "vegetarian", "$25"]) {
      await handleDM({ planId: "done", userId: u, text }, doneStore);
    }
  }
  const afterDone: string[] = [];
  for (const text of ["ok", "cool", "anything else"]) {
    afterDone.push((await handleDM({ planId: "done", userId: "d1", text }, doneStore)).reply);
  }
  check(
    "a finished participant is told what is actually outstanding",
    afterDone.every((r) => !r.includes("Working it out")),
    afterDone[0]?.slice(0, 40),
  );
  let doneRepeats = 0;
  for (let i = 1; i < afterDone.length; i++) if (afterDone[i] === afterDone[i - 1]) doneRepeats++;
  check("and never the same line twice running", doneRepeats === 0);
  await doneStore.close();

  // Withdrawing a vote. Un-tapping an option on a native poll is not the same as
  // changing it -- the person is undecided again, and the tally has to agree
  // with what the poll on their phone now shows.
  const unvoteStore = await openStore({ memory: true });
  await unvoteStore.createPlan({
    _id: "uv", joinCode: "UV01", participants: ["p1", "p2"], status: "proposed", slots: {},
  });
  await unvoteStore.setShortlist("uv", ["joes-pizza", "taim"]);
  await unvoteStore.recordVote("uv", "p1", "joes-pizza");
  await unvoteStore.removeVote("uv", "p1");
  check("withdrawing leaves no vote behind", Object.keys((await unvoteStore.getPlan("uv"))?.votes ?? {}).length === 0);
  await unvoteStore.recordVote("uv", "p1", "taim");
  await unvoteStore.recordVote("uv", "p2", "taim");
  await unvoteStore.removeVote("uv", "p2");
  check(
    "and removes only that person's",
    (await unvoteStore.getPlan("uv"))?.votes?.p1 === "taim" &&
      (await unvoteStore.getPlan("uv"))?.votes?.p2 === undefined,
  );
  await unvoteStore.close();

  // A tie must not be decided for people. With two participants ANY
  // disagreement ties, so silently taking the higher-scoring option overrules
  // somebody every single time.
  check(
    "a two-way split has no winner by count",
    tallyVotes({ u1: "a", u2: "b" }, ["a", "b"]).counts.a === 1 &&
      tallyVotes({ u1: "a", u2: "b" }, ["a", "b"]).counts.b === 1,
  );
  check(
    "a clear majority does have one",
    tallyVotes({ u1: "b", u2: "b", u3: "a" }, ["a", "b"]).winner === "b",
  );
  // The poll is on by default now. A real run got the numbered text because it
  // was behind a flag nobody set, so this asserts what actually ships and that a
  // tap and a typed number resolve to the same thing.
  const pollRun = await negotiate(await openStore({ memory: true }), "neg-poll", easy, day);
  if (pollRun.status === "settled" && pollRun.shortlist.length > 1) {
    const labels = pollRun.shortlist.map((id) => {
      const v = venueById(id)!;
      return `${v.name} · $${v.estCostUSD}`;
    });
    check(
      "every poll option resolves back to its own venue",
      labels.every((label, i) => parseVote(label, pollRun.shortlist) === pollRun.shortlist[i]),
      labels.join(" | "),
    );
    check(
      "and typing the number picks the same one as tapping it",
      parseVote("2", pollRun.shortlist) === pollRun.shortlist[1],
    );
  }
  check("the native poll ships unless it is turned off", process.env.UNSAID_POLL !== "0");

  check(
    "a priced poll label still resolves to its venue",
    parseVote("Joe's Pizza · $12", ["joes-pizza", "taim"]) === "joes-pizza" &&
      parseVote("Mamoun's Falafel · $10", ["mamouns", "taim"]) === "mamouns",
  );

  // Meta-turns. A question is not an answer -- previously nine asides walked a
  // person through onboarding and all the way to "got everything I need".
  check(
    "asides are recognised for what they are",
    classifyMeta("help") === "help" &&
      classifyMeta("why do you need that") === "why" &&
      classifyMeta("who else is coming") === "who" &&
      classifyMeta("?") === "confused" &&
      classifyMeta("😂") === "confused",
  );
  check(
    "a real answer is never mistaken for an aside",
    classifyMeta("bushwick") === null &&
      classifyMeta("$25") === null &&
      classifyMeta("after 7") === null &&
      classifyMeta("i eat everything") === null,
  );

  const metaStore = await openStore({ memory: true });
  await metaStore.upsertUser({
    _id: "mu", phone: "mu", profile: { tastes: [], preferredSpots: [] },
    onboardedAt: "now", askedProfile: [], wishlist: [],
  });
  await handleDM({ planId: "mp2", userId: "mu", text: "dinner?" }, metaStore);
  const askedOnce = (await metaStore.getSlots("mp2", "mu")).attempts?.home ?? 0;
  const asides: string[] = [];
  for (const probe of ["?", "huh", "?", "help", "help", "who else is coming"]) {
    asides.push((await handleDM({ planId: "mp2", userId: "mu", text: probe }, metaStore)).reply);
  }
  check(
    "six asides do not burn a single retry",
    ((await metaStore.getSlots("mp2", "mu")).attempts?.home ?? 0) === askedOnce,
  );
  check(
    "and nothing was silently assumed on their behalf",
    (await metaStore.getSlots("mp2", "mu")).home?.value == null,
  );
  let metaRepeats = 0;
  for (let i = 1; i < asides.length; i++) if (asides[i] === asides[i - 1]) metaRepeats++;
  check("no two consecutive asides get the same reply", metaRepeats === 0, `(${metaRepeats})`);
  await metaStore.close();

  // Voting. "Reply 1, 2 or 3" was an instruction the system could not honour.
  check(
    "a vote parses as a number, a hash, a word or a name",
    parseVote("2", ["a", "mamouns", "c"]) === "mamouns" &&
      parseVote("#2", ["a", "mamouns", "c"]) === "mamouns" &&
      parseVote("option 2", ["a", "mamouns", "c"]) === "mamouns" &&
      parseVote("mamouns falafel", ["a", "mamouns", "c"]) === "mamouns",
  );
  check(
    "nonsense is not a vote, and neither is an out-of-range number",
    parseVote("what kind of democracy is this", ["a", "b"]) === null &&
      parseVote("9", ["a", "b"]) === null,
  );
  check(
    "most votes wins",
    tallyVotes({ u1: "b", u2: "b", u3: "a" }, ["a", "b"]).winner === "b",
  );
  check(
    "a tie falls back to shortlist order, which is fairest-first",
    tallyVotes({ u1: "a", u2: "b" }, ["a", "b"]).winner === "a",
  );

  // The plan date. "dinner friday?" was silently planning for today.
  const wed = new Date("2026-09-30T12:00:00");
  check(
    "a weekday in the opening message becomes the plan date",
    resolveDate("dinner friday?", wed)?.getDay() === 5 &&
      resolveDate("tomorrow", wed)?.getDate() === 1 &&
      resolveDate("tonight", wed)?.getDate() === 30,
  );
  check(
    "'next <today>' means next week, a bare weekday means the coming one",
    resolveDate("next wednesday", wed)?.getDate() === 7 &&
      resolveDate("wednesday", wed)?.getDate() === 30,
  );
  check("an opening with no day at all resolves to nothing", resolveDate("dinner sometime", wed) === null);

  const dateStore = await openStore({ memory: true });
  await dateStore.createPlan({
    _id: "dp", joinCode: "DP01", participants: ["du"], status: "collecting", slots: {},
  });
  await dateStore.setPlanDate("dp", "2026-10-02");
  await dateStore.upsertUser({
    _id: "du", phone: "du",
    profile: { home: { lat: 40.72, lng: -73.99, label: "East Village" }, tastes: [], preferredSpots: [],
      blackouts: [{ days: [2], start: "18:00", end: "23:59" }] },
    onboardedAt: "now", wishlist: [],
  });
  await handleDM({ planId: "dp", userId: "du", text: "dinner?" }, dateStore);
  await handleDM({ planId: "dp", userId: "du", text: "after 7" }, dateStore);
  const dated = await dateStore.getSlots("dp", "du");
  check(
    "times resolve on the plan's day, not today",
    dated.window?.value?.start.startsWith("2026-10-02") === true,
    dated.window?.value?.start ?? "unset",
  );
  check(
    "a Tuesday blackout does not clip a Friday plan",
    dated.window?.value !== null && dated.window?.value !== undefined,
  );
  await dateStore.close();

  // The status command: the thing that makes every other bug debuggable.
  const stStore = await openStore({ memory: true });
  await stStore.createPlan({
    _id: "st", joinCode: "ST01",
    participants: ["+15551230001", "+15551230002"],
    status: "collecting", slots: {},
  });
  check(
    "status recognises how people actually ask",
    ["status", "where are we", "who's left", "@unsaid status", "status?"].every(parseStatus) &&
      !parseStatus("after 7") &&
      !parseStatus("status of my budget"),
  );
  for (const text of ["dinner?", "bushwick", "vegetarian", "none", "none", "after 7", "an hour", "$25 tops"]) {
    await handleDM({ planId: "st", userId: "+15551230001", text }, stStore);
  }
  const report = await planStatus(stStore, "st", "+15551230001");
  check("status names the plan and its state", report.includes("ST01") && report.includes("collecting"));
  check("status marks the caller as you", report.includes("you: ready"));
  check("status shows others by last four digits only", report.includes("···0002"));
  check("status says the group figure is partial", report.includes("1 of 2 answered"));
  check("status reports the caller's own profile", report.includes("Your profile: Bushwick"));
  check(
    "status never leaks another person's values",
    !report.includes("15551230002 ·") && report.split("\n").filter((l) => l.includes("0002")).length === 1,
  );
  check(
    "status handles not being in a plan",
    (await planStatus(stStore, undefined, "+15559999999")).includes("not in a plan"),
  );
  await stStore.close();

  // Regressions found once A's router was exercised end to end.
  check(
    "a short alias does not match inside a longer word",
    (await resolveHome("i eat everything")).value === null &&
      (await resolveHome("whatever is fine")).value === null &&
      (await resolveHome("unless you prefer")).value === null,
  );
  check(
    "real locations still resolve",
    (await resolveHome("im in bushwick")).value?.label === "Bushwick" &&
      (await resolveHome("near WTC")).value?.label === "World Trade Center",
  );

  const mindStore = await openStore({ memory: true });
  const tell = (planId: string, text: string) =>
    handleDM({ planId, userId: "mind", text }, mindStore);
  for (const text of ["dinner friday?", "bushwick", "vegetarian", "none", "none"]) {
    await tell("mp1", text);
  }
  const onboarded = (await mindStore.getUser("mind"))?.profile;
  check(
    "the message that completes onboarding is not re-read as a plan answer",
    onboarded?.dietary?.includes("vegetarian") === true,
    JSON.stringify(onboarded?.dietary),
  );
  check('declining favourites does not store "none" as a taste', onboarded?.tastes.includes("none") === false);

  await tell("mp2", "dinner sunday?");
  await tell("mp2", "i eat everything");
  const changed = (await mindStore.getUser("mind"))?.profile.dietary;
  check(
    "changing to 'i eat everything' clears the stored dietary need",
    Array.isArray(changed) && changed.length === 0,
    JSON.stringify(changed),
  );
  const afterChange = await tell("mp3", "dinner monday?");
  check(
    "and the next plan seeds it rather than asking again",
    !afterChange.missing.includes("dietary"),
  );
  await mindStore.close();

  // Leaving a plan: membership AND slots must go, or `go` waits forever.
  const leaveStore = await openStore({ memory: true });
  await leaveStore.createPlan({
    _id: "lv", joinCode: "LV01", participants: ["host", "quitter"],
    status: "collecting", slots: {},
  });
  await leaveStore.setSlots("lv", "quitter", { budgetCapUSD: { raw: "5", value: 5, confidence: "high" } });
  await leaveStore.setSlots("lv", "host", { budgetCapUSD: { raw: "40", value: 40, confidence: "high" } });
  await leaveStore.removeParticipant("lv", "quitter");
  const afterLeave = await leaveStore.getPlan("lv");
  check("removeParticipant drops membership", afterLeave?.participants.join() === "host");
  check(
    "and drops their stale slots so they stop constraining the group",
    afterLeave?.slots.quitter === undefined && afterLeave?.slots.host !== undefined,
  );

  // A narrow favourite write, so nobody needs upsertUser for one field.
  await leaveStore.setActivePlan("fav", "lv");
  await leaveStore.addFavorite("fav", "joes-pizza");
  await leaveStore.addFavorite("fav", "joes-pizza");
  const favUser = await leaveStore.getUser("fav");
  check("addFavorite is idempotent", favUser?.profile.preferredSpots.join() === "joes-pizza");
  check("addFavorite leaves the active plan alone", favUser?.activePlanId === "lv");

  // upsertUser must MERGE, not replace -- the two stores disagreed before.
  await leaveStore.upsertUser({
    _id: "fav", phone: "fav",
    profile: { tastes: ["pizza"], preferredSpots: ["joes-pizza"] },
    wishlist: [],
  });
  check(
    "upsertUser preserves fields the caller omitted",
    (await leaveStore.getUser("fav"))?.activePlanId === "lv",
  );
  await leaveStore.close();

  // setActivePlan must not disturb what onboarding built.
  const joinStore = live;
  await joinStore.upsertUser({
    _id: U("join"),
    phone: "+1555",
    profile: { home: { lat: 1, lng: 2, label: "Bushwick" }, tastes: ["pizza"], preferredSpots: [] },
    onboardedAt: "2026-09-26T00:00:00Z",
    wishlist: [],
  });
  await joinStore.setActivePlan(U("join"), P("z"));
  const joined = await joinStore.getUser(U("join"));
  check("setActivePlan records the plan", joined?.activePlanId === P("z"));
  check("and leaves the profile intact", joined?.profile.home?.label === "Bushwick");
  check("and leaves onboarding state intact", joined?.onboardedAt !== undefined);
  await joinStore.setActivePlan(U("fresh"), P("z"));
  check("setActivePlan creates a user that does not exist yet", (await joinStore.getUser(U("fresh")))?.activePlanId === P("z"));
  usedUsers.push(U("join"), U("fresh"));

  // Plan CRUD. A's join flow depends on every one of these.
  const planStore = live;
  const plan: PlanDoc = {
    _id: P("1"),
    joinCode: `C${RUN.slice(-3)}`,
    participants: [U("m")],
    status: "collecting",
    slots: {},
  };
  check("createPlan succeeds on a free code", (await planStore.createPlan(plan)) === true);
  check("getPlanByJoinCode finds it", (await planStore.getPlanByJoinCode(`C${RUN.slice(-3)}`))?._id === P("1"));
  check("an unknown code returns null", (await planStore.getPlanByJoinCode("ZZZZ")) === null);
  check("a blank code never matches", (await planStore.getPlanByJoinCode("")) === null);
  check(
    "a taken code is refused",
    (await planStore.createPlan({ ...plan, _id: P("2") })) === false,
  );

  await planStore.addParticipant(P("1"), U("dev"));
  await planStore.addParticipant(P("1"), U("dev"));
  check(
    "addParticipant is idempotent",
    (await planStore.getPlan(P("1")))?.participants.join(",") === `${U("m")},${U("dev")}`,
  );

  await planStore.setSlots(P("1"), U("m"), { tags: ["pizza"] });
  check(
    "slots round-trip through the plan document",
    (await planStore.getSlots(P("1"), U("m"))).tags?.[0] === "pizza",
  );

  await planStore.setStatus(P("1"), "confirmed");
  check(
    "a confirmed plan stops answering to its code",
    (await planStore.getPlanByJoinCode(`C${RUN.slice(-3)}`)) === null,
  );
  check(
    "so the code can be reused by a new plan",
    (await planStore.createPlan({ ...plan, _id: P("3") })) === true,
  );
  usedPlans.push(P("1"), P("2"), P("3"));

  // The backroom screen, checked without binding a port. Memory-backed so
  // repeated runs do not accumulate DEMO_ROUNDS in a persistent store.
  const backroomPlan = P("screen");
  for (const round of DEMO_ROUNDS) await live.appendRound({ ...round, planId: backroomPlan });
  const state = await buildState(live, backroomPlan);
  const first = state.rounds[0];
  check("backroom state builds a round", state.rounds.length === 1);
  check(
    "candidates are joined to venue names",
    (first?.candidates ?? []).length > 0 &&
      (first?.candidates ?? []).every((c) => venueById(c.venueId)?.name === c.name),
  );
  check(
    "the projector caps how many survivors it draws",
    /SURVIVORS_SHOWN/.test(readFileSync(new URL("./backroom/page.html", import.meta.url), "utf8")),
  );
  check(
    "and candidates carry a cuisine and a price tier for the screen",
    (first?.candidates ?? []).filter((c) => c.passed).every((c) => typeof c.price === "string"),
  );
  check(
    "rejections carry a category and no reason text",
    (first?.candidates ?? [])
      .filter((c) => !c.passed)
      .every((c) => typeof c.failedOn === "string" && !("reason" in c)),
  );
  const page = readFileSync(new URL("./backroom/page.html", import.meta.url), "utf8");
  check(
    "projector page wires every id its script reads",
    ["candidates", "reveal", "toggle", "status"].every((id) => page.includes(`id="${id}"`)),
  );
  check("projector page polls /api/state", page.includes("/api/state"));
  usedPlans.push(backroomPlan);

  // A plan brought into existence by an upsert must still be a complete PlanDoc,
  // not just an _id plus the one field that was written.
  const implicit = P("implicit");
  await live.setSlots(implicit, U("m"), { tags: ["y"] });
  const upserted = await live.getPlan(implicit);
  check(
    "an upserted plan is a complete document",
    upserted?.status === "collecting" &&
      Array.isArray(upserted?.participants) &&
      typeof upserted?.joinCode === "string" &&
      upserted?.slots[U("m")]?.tags?.[0] === "y",
  );
  usedPlans.push(implicit);

  // The only assertion that isolates the Grok path: offline assigns the WHOLE
  // message to each matching slot, so a shorter value proves the model returned
  // a real span. Without this, an empty Grok response merges away to offline and
  // every other check still passes.
  if (GROK_KEY) process.env.XAI_API_KEY = GROK_KEY;

  if (GROK_KEY) {
    const sentence = "im in bushwick and $25 tops, nothing with nuts";
    const spans = await extract(sentence, {});
    check(
      "Grok returned spans, not the whole message",
      typeof spans.budgetRaw === "string" && spans.budgetRaw.length < sentence.length,
      `(budgetRaw = ${JSON.stringify(spans.budgetRaw)})`,
    );
    check("Grok found the location offline missed as a span", typeof spans.homeRaw === "string");
  } else {
    console.log("  SKIP  Grok span check (XAI_API_KEY not set)");
  }

  const onMongo = Boolean(process.env.MONGODB_URI);
  check(
    "every check above ran against MongoDB",
    onMongo,
    onMongo ? "" : "(MONGODB_URI not set - ran in memory)",
  );

  // Drive A's router, not just B's lane. Nothing here exercised routeMessage
  // before, which is why a `status === "negotiating"` bail-out that ran before
  // the whisper handler went unnoticed: the private question arrived, the answer
  // was swallowed, and the plan sat paused forever.
  const drive = async (answer: string) => {
    const store = await openStore({ memory: true });
    const A = "+15559001", B = "+15559002";
    const inbox: Record<string, string[]> = { [A]: [], [B]: [] };
    const space = (p: string) => ({
      id: `dm-${p}`, type: "dm" as const, phone: p,
      async responding(f: () => Promise<void>) { await f(); },
      async send(c: unknown) { inbox[p]!.push(typeof c === "string" ? c : "[poll]"); },
    });
    const inbound = (p: string, t: string) => ({
      direction: "inbound" as const,
      content: { type: "text" as const, text: t },
      sender: { id: p },
    });
    const lookup = { async get(id: string) { return space(id.replace("dm-", "")) as never; } } as never;
    const talk = (p: string, t: string) =>
      routeMessage(space(p) as never, inbound(p, t) as never, store, lookup);

    // Same neighbourhood, no dietary needs, one tight hedged cap: money is the
    // only wall, so the hedged person is the only one who can help.
    const tight = ["east village", "i eat everything", "none", "none", "8pm", "1 hr", "$5 tops, kinda broke rn"];
    const loose = ["east village", "i eat everything", "none", "none", "8pm", "1 hr", "$60"];
    await talk(A, "dinner friday");
    for (const t of tight) await talk(A, t);
    const planId = (await store.getUser(A))!.activePlanId!;
    await talk(B, `JOIN ${(await store.getPlan(planId))!.joinCode}`);
    for (const t of loose) await talk(B, t);
    await talk(A, "go");
    const asked = inbox[A]!.at(-1) ?? "";
    await talk(A, answer);
    const afterAnswer = (await store.getPlan(planId))!;
    // Carry on to the end when there is something to vote on, so the settled
    // card is exercised too.
    if (afterAnswer.status === "proposed") {
      // More than one option is a vote; a single option is settled with a 👍.
      const pick = (afterAnswer.shortlist ?? []).length > 1 ? "1" : "yes";
      await talk(A, pick);
      await talk(B, pick);
    }
    const plan = (await store.getPlan(planId))!;
    const result = {
      asked,
      replied: inbox[A]!.at(-1) ?? "",
      status: afterAnswer.status,
      shortlist: afterAnswer.shortlist ?? [],
      settled: plan.status,
      chosen: plan.chosen,
      card: inbox[B]!.at(-1) ?? "",
      joined: inbox[B]![0] ?? "",
      invite: inbox[A]![0] ?? "",
    };
    await store.close();
    return result;
  };

  const saidYes = await drive("yeah ok");
  check(
    "the private ask reaches the one person who could move",
    /could you do \$/i.test(saidYes.asked) && /fine to say no/i.test(saidYes.asked),
    saidYes.asked.slice(0, 60),
  );
  check(
    "answering it is not swallowed by the negotiating status",
    saidYes.status === "proposed" && saidYes.shortlist.length > 0,
    `${saidYes.status} · ${saidYes.shortlist.length} options`,
  );
  // What the organiser decided has to reach everybody else. Until now the joiner
  // was asked their budget for a plan they could not see.
  check(
    "the pasted invite says what it is for",
    /dinner/i.test(saidYes.invite) && /JOIN/.test(saidYes.invite),
    saidYes.invite.split("\n").at(-1) ?? "",
  );
  check(
    "and the joiner is told the plan when they join",
    /the plan is/i.test(saidYes.joined) && /dinner/i.test(saidYes.joined),
    saidYes.joined.split("\n")[0] ?? "",
  );
  check(
    "settling records the pick, which nothing used to write",
    saidYes.settled === "confirmed" && typeof saidYes.chosen?.venueId === "string",
    `${saidYes.settled} · ${saidYes.chosen?.venueId ?? "none"}`,
  );
  check(
    "and the settled card carries a map and transit from where that person is",
    /maps\.google\.com|google\.com\/maps/.test(saidYes.card) &&
      /travelmode=transit/.test(saidYes.card) &&
      /origin=/.test(saidYes.card),
    saidYes.card.split("\n").at(-2) ?? "",
  );

  const saidNo = await drive("sorry, cant");
  check(
    "declining ends somewhere rather than hanging",
    saidNo.status !== "negotiating" && saidNo.replied.length > 0 && !/working on it/i.test(saidNo.replied),
    `${saidNo.status}: ${saidNo.replied.split("\n")[0]}`,
  );

  // The in-memory store is the venue-Wi-Fi fallback, so prove it still works.
  const fallback = await openStore({ memory: true });
  await fallback.createPlan({
    _id: "mem", joinCode: "MEM0", participants: [], status: "collecting", slots: {},
  });
  await fallback.setSlots("mem", "u", { tags: ["x"] });
  check(
    "in-memory fallback still works",
    (await fallback.getPlanByJoinCode("MEM0"))?._id === "mem" &&
      (await fallback.getSlots("mem", "u")).tags?.[0] === "x",
  );
  await fallback.close();

  for (const planId of usedPlans) await live.deletePlan(planId);
  for (const userId of usedUsers) await live.deleteUser(userId);
  check("teardown removed this run's documents", (await live.getPlan(P("1"))) === null);
  await live.close();

  console.log(
    failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
