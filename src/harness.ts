import "dotenv/config";
import { readFileSync } from "node:fs";
import type { Candidate, Evaluation, MergedConstraints, PlanDoc } from "./contracts.ts";
import { MERGED_KEYS } from "./contracts.ts";
import { type Participant, hasOverlap, mergeConstraints, travelProfiles } from "./aggregator.ts";
import { type RawSlots, resolveBudget, resolveDietary, resolveHome, resolveSlots } from "./resolve/index.ts";
import { scoreCandidates } from "./agent/score.ts";
import { handleDM } from "./slots.ts";
import { extractOffline } from "./agent/extract.ts";
import { resolveBlackouts } from "./resolve/blackout.ts";
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

  // handleDM drives onboarding first, then plan slot-filling.
  const dmStore = await openStore({ memory: true });
  const say = async (userId: string, planId: string, text: string) =>
    handleDM({ planId, userId, text }, dmStore);

  console.log("\nONBOARDING A NEW USER");
  const onboarding = [
    "dinner friday?",
    "bushwick",
    "vegetarian",
    "class on tuesday nights",
    "joe's pizza",
  ];
  let turn = await say("new-maya", "plan-a", onboarding[0]!);
  console.log(`  "${onboarding[0]}"`.padEnd(30) + `-> ${turn.reply}`);
  check("onboarding starts with location, not budget", /where do you usually/i.test(turn.reply));
  for (const text of onboarding.slice(1)) {
    turn = await say("new-maya", "plan-a", text);
    console.log(`  "${text}"`.padEnd(30) + `-> ${turn.reply}`);
  }

  const profile = (await dmStore.getUser("new-maya"))?.profile;
  check("profile learned home", profile?.home?.label.toLowerCase().includes("bushwick") === true);
  check("profile learned dietary", profile?.dietary?.includes("vegetarian") === true);
  check("profile learned a Tuesday blackout", profile?.blackouts?.[0]?.days.includes(2) === true);
  check("a named favourite became a venue id", profile?.preferredSpots.includes("joes-pizza") === true);
  check("onboarding completed", (await dmStore.getUser("new-maya"))?.onboardedAt !== undefined);
  check("after onboarding it asks about time, not location", /what time works/i.test(turn.reply));
  check("and it says what it reused", /from your profile/i.test(turn.reply));

  console.log("\nSAME USER, SECOND PLAN (profile already known)");
  let second = await say("new-maya", "plan-b", "dinner sunday?");
  console.log(`  "dinner sunday?"`.padEnd(30) + `-> ${second.reply}`);
  check(
    "a returning user is not asked for location or diet again",
    !second.missing.includes("home") && !second.missing.includes("dietary"),
  );
  check("but budget is still asked every plan", second.missing.includes("budgetCapUSD"));

  for (const text of ["after 7", "i dont mind traveling", "$25 tops"]) {
    second = await say("new-maya", "plan-b", text);
    console.log(`  "${text}"`.padEnd(30) + `-> ${second.reply}`);
  }
  check("second plan completes in three answers", second.missing.length === 0);
  check("budget resolved to 25", second.slots.budgetCapUSD?.value === 25);
  check("budget stayed out of the profile", !("defaultBudgetUSD" in ((await dmStore.getUser("new-maya"))?.profile ?? {})));

  const transcript = await dmStore.listMessages("plan-b", "new-maya");
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
  await dmStore.close();

  // setActivePlan must not disturb what onboarding built.
  const joinStore = await openStore({ memory: true });
  await joinStore.upsertUser({
    _id: "join-u",
    phone: "+1555",
    profile: { home: { lat: 1, lng: 2, label: "Bushwick" }, tastes: ["pizza"], preferredSpots: [] },
    onboardedAt: "2026-09-26T00:00:00Z",
    wishlist: [],
  });
  await joinStore.setActivePlan("join-u", "plan-z");
  const joined = await joinStore.getUser("join-u");
  check("setActivePlan records the plan", joined?.activePlanId === "plan-z");
  check("and leaves the profile intact", joined?.profile.home?.label === "Bushwick");
  check("and leaves onboarding state intact", joined?.onboardedAt !== undefined);
  await joinStore.setActivePlan("brand-new", "plan-z");
  check("setActivePlan creates a user that does not exist yet", (await joinStore.getUser("brand-new"))?.activePlanId === "plan-z");
  await joinStore.close();

  // Plan CRUD. A's join flow depends on every one of these.
  const planStore = await openStore({ memory: true });
  const plan: PlanDoc = {
    _id: "plan-1",
    joinCode: "K7M2",
    participants: ["maya"],
    status: "collecting",
    slots: {},
  };
  check("createPlan succeeds on a free code", (await planStore.createPlan(plan)) === true);
  check("getPlanByJoinCode finds it", (await planStore.getPlanByJoinCode("K7M2"))?._id === "plan-1");
  check("an unknown code returns null", (await planStore.getPlanByJoinCode("ZZZZ")) === null);
  check("a blank code never matches", (await planStore.getPlanByJoinCode("")) === null);
  check(
    "a taken code is refused",
    (await planStore.createPlan({ ...plan, _id: "plan-2" })) === false,
  );

  await planStore.addParticipant("plan-1", "dev");
  await planStore.addParticipant("plan-1", "dev");
  check(
    "addParticipant is idempotent",
    (await planStore.getPlan("plan-1"))?.participants.join(",") === "maya,dev",
  );

  await planStore.setSlots("plan-1", "maya", { tags: ["pizza"] });
  check(
    "slots round-trip through the plan document",
    (await planStore.getSlots("plan-1", "maya")).tags?.[0] === "pizza",
  );

  await planStore.setStatus("plan-1", "confirmed");
  check(
    "a confirmed plan stops answering to its code",
    (await planStore.getPlanByJoinCode("K7M2")) === null,
  );
  check(
    "so the code can be reused by a new plan",
    (await planStore.createPlan({ ...plan, _id: "plan-3" })) === true,
  );
  await planStore.close();

  // The backroom screen, checked without binding a port. Memory-backed so
  // repeated runs do not accumulate DEMO_ROUNDS in a persistent store.
  const store = await openStore({ memory: true });
  for (const round of DEMO_ROUNDS) await store.appendRound(round);
  const state = await buildState(store, DEMO_PLAN_ID);
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
  await store.close();

  if (process.env.MONGODB_URI) {
    const atlas = await openStore();
    const probeId = `probe-${Date.now().toString(36)}`;
    const created = await atlas.createPlan({
      _id: probeId,
      joinCode: probeId.slice(-4),
      participants: ["probe"],
      status: "collecting",
      slots: {},
    });
    await atlas.setSlots(probeId, "probe", { tags: ["atlas"] });
    const readBack = await atlas.getSlots(probeId, "probe");
    const found = await atlas.getPlanByJoinCode(probeId.slice(-4));
    await atlas.setStatus(probeId, "confirmed");
    await atlas.close();
    check(
      "MongoDB: plan written, slots read back, code resolved",
      created && readBack.tags?.[0] === "atlas" && found?._id === probeId,
    );
  } else {
    console.log("  SKIP  MongoDB check (MONGODB_URI not set, running in memory)");
  }

  console.log(
    failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

await main();
