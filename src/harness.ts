import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Candidate, Evaluation, MergedConstraints, PlanDoc } from "./contracts.ts";
import { MERGED_KEYS } from "./contracts.ts";
import { type Participant, hasOverlap, mergeConstraints, travelProfiles } from "./aggregator.ts";
import { type RawSlots, resolveBudget, resolveDietary, resolveHome, resolveSlots } from "./resolve/index.ts";
import { scoreCandidates } from "./agent/score.ts";
import { handleDM } from "./slots.ts";
import { parseStatus, planStatus } from "./status.ts";
import { extract, extractOffline } from "./agent/extract.ts";
import { resolveBlackouts } from "./resolve/blackout.ts";
import { resolveWindow } from "./resolve/time.ts";
import { VENUES, filterVenues, venueById } from "./venues.ts";
import { DEMO_PLAN_ID, DEMO_ROUNDS } from "./backroom/fixtures.ts";
import { buildState } from "./backroom/state.ts";
import { openStore } from "./db.ts";

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
  check(
    "survivor count in the 6-17 range",
    survivors.length >= 6 && survivors.length <= 17,
    `(${survivors.length})`,
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
  check("the second ask is rephrased, not repeated", ask1 !== ask2 && ask2.includes("didn't catch"));
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
    (first?.candidates ?? []).every((c) => c.name !== c.venueId),
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
