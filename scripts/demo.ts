process.env.UNSAID_QUIET ??= "1";
// Same keys the real app runs with, so the geocoder and Grok are in play.
import "dotenv/config";
import { openStore } from "../src/db.ts";
import { routeMessage } from "../src/router.ts";

// A scripted rehearsal: every scenario driven through A's real router with fake
// Spectrum spaces, so the whole flow can be checked without three phones.
//
//   npm run demo                 the seven scenarios, replies only
//   npm run demo -- --verbose    with the bot's own running commentary
//   npm run demo -- 2 5          only those scenarios

const args = process.argv.slice(2);
if (args.includes("--verbose")) process.env.UNSAID_QUIET = "0";
const only = args.filter((a) => /^\d+$/.test(a)).map(Number);

const ANSWERS = {
  // In the order the agent asks: home, dietary, blackouts, favourites, time, travel, budget.
  standard: ["east village", "i eat everything", "none", "none", "8pm", "40 min", "$40"],
  brunch: ["east village", "i eat everything", "none", "none", "11", "1 hr", "$30"],
  boba: ["east village", "i eat everything", "none", "none", "4pm", "20 min", "$8"],
  earlyCoffee: ["east village", "i eat everything", "none", "none", "8am", "20 min", "$10"],
  broke: ["east village", "i eat everything", "none", "none", "8pm", "1 hr", "$5 tops, kinda broke rn"],
  loaded: ["east village", "i eat everything", "none", "none", "8pm", "1 hr", "$60"],
  vegan: ["east village", "vegan", "none", "none", "8pm", "1 hr", "$40"],
  kosher: ["east village", "kosher", "none", "none", "8pm", "1 hr", "$40"],
};

type Script = {
  title: string;
  opening: string;
  a: string[];
  b: string[];
  // Prefixed "B:" for the joiner, otherwise the host.
  then: string[];
};

const SCENARIOS: Script[] = [
  {
    title: "Sunday brunch — the occasion, the date, and an 11 that means 11am",
    opening: "sunday brunch?", a: ANSWERS.brunch, b: ANSWERS.brunch, then: ["go"],
  },
  {
    title: "Boba after class — what the organiser asked for reaches the pick",
    opening: "boba after class?", a: ANSWERS.boba, b: ANSWERS.boba, then: ["go"],
  },
  {
    title: "Somewhere nice — affordability as a preference, not just a cap",
    opening: "somewhere nice for dinner friday", a: ANSWERS.standard, b: ANSWERS.standard, then: ["go"],
  },
  {
    title: "Coffee at 8am — opening hours decide what is even possible",
    opening: "coffee tomorrow morning", a: ANSWERS.earlyCoffee, b: ANSWERS.earlyCoffee, then: ["go"],
  },
  {
    title: "A tight, hedged budget — the private ask, then a yes",
    opening: "dinner friday", a: ANSWERS.broke, b: ANSWERS.loaded, then: ["go", "yeah ok"],
  },
  {
    title: "The same ask, declined — it ends somewhere instead of hanging",
    opening: "dinner friday", a: ANSWERS.broke, b: ANSWERS.loaded, then: ["go", "sorry, cant"],
  },
  {
    title: "Vegan and kosher — fails honestly, and asks nobody to flex",
    opening: "dinner friday", a: ANSWERS.vegan, b: ANSWERS.kosher, then: ["go"],
  },
  {
    title: "Two people vote — the winner goes out with directions for each of them",
    opening: "dinner friday", a: ANSWERS.standard, b: ANSWERS.standard,
    then: ["go", "2", "B:2", "B:im at 60th and lex actually", "status"],
  },
];

async function play(script: Script, n: number): Promise<void> {
  const store = await openStore({ memory: true });
  const A = "+15550001", B = "+15550002";
  const inbox: Record<string, string[]> = { [A]: [], [B]: [] };
  const space = (p: string) => ({
    id: `dm-${p}`, type: "dm" as const, phone: p,
    async responding(f: () => Promise<void>) { await f(); },
    async send(c: unknown) { inbox[p]!.push(typeof c === "string" ? c : `[native poll]`); },
  });
  const inbound = (p: string, t: string) => ({
    direction: "inbound" as const,
    content: { type: "text" as const, text: t },
    sender: { id: p },
  });
  const lookup = { async get(id: string) { return space(id.replace("dm-", "")) as never; } } as never;

  let show = false;
  const talk = async (p: string, t: string) => {
    const before = inbox[p]!.length;
    const otherBefore = inbox[p === A ? B : A]!.length;
    await routeMessage(space(p) as never, inbound(p, t) as never, store, lookup);
    if (!show) return;
    console.log(`  ${p === A ? "host" : "  joiner"} → ${t}`);
    for (const reply of inbox[p]!.slice(before)) {
      for (const line of reply.split("\n")) console.log(`      ${line}`);
    }
    // Anything the other person got at the same time: a fan-out, or a private ask.
    const other = p === A ? B : A;
    for (const reply of inbox[other]!.slice(otherBefore)) {
      console.log(`      ↳ also sent to ${other === A ? "the host" : "the joiner"}: ${reply.split("\n")[0]}`);
    }
  };

  console.log(`\n━━━ ${n}. ${script.title}`);
  show = n === 1; // the first scenario shows the invite and the join in full
  await talk(A, script.opening);
  show = false;
  for (const t of script.a) await talk(A, t);
  const planId = (await store.getUser(A))!.activePlanId!;
  const joinCode = (await store.getPlan(planId))!.joinCode;
  show = n === 1;
  await talk(B, `JOIN ${joinCode}`);
  show = false;
  for (const t of script.b) await talk(B, t);

  show = true;
  for (const t of script.then) await talk(t.startsWith("B:") ? B : A, t.replace(/^B:/, ""));

  const plan = (await store.getPlan(planId))!;
  console.log(
    `  ⟨${plan.occasion ?? "?"}${plan.date ? ` ${plan.date}` : ""} · ${plan.status}` +
      `${plan.vibe?.length ? ` · asked for: ${plan.vibe.join(", ")}` : ""}` +
      `${Object.keys(plan.votes ?? {}).length ? ` · votes ${JSON.stringify(plan.votes)}` : ""}⟩`,
  );
  await store.close();
}

for (const [i, script] of SCENARIOS.entries()) {
  if (only.length && !only.includes(i + 1)) continue;
  await play(script, i + 1);
}
console.log("");
