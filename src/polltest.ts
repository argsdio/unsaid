import "dotenv/config";
import { Spectrum, option, poll } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

// Probes what this line can actually deliver to one phone. Poll, tapback and
// message effects are all iMessage-only; if the line falls back to SMS they all
// silently stop working and the confirm step has no mechanism.
//
//   npm run polltest -- +15551234567
const to = process.argv[2];
if (!to?.startsWith("+")) {
  console.error('Usage: npm run polltest -- +15551234567');
  process.exit(1);
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const space = await im.space.get(`any;-;${to}`);

async function probe(label: string, send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    console.log(`  OK    ${label}`);
    return true;
  } catch (err) {
    console.log(`  FAIL  ${label} — ${(err as Error).message.slice(0, 110)}`);
    return false;
  }
}

console.log(`\nwhat this line can deliver to ${to}:`);
const text = await probe("plain text", () => space.send("Unsaid capability check — you can ignore this."));
const withPoll = await probe("native poll", () =>
  space.send(poll("Which one?", option("Xi'an Famous Foods · $14"), option("Superiority Burger · $17"))),
);

console.log("\nwhat this means:");
if (!text) {
  console.log("  This line cannot reach that number at all. Nothing will work.");
} else if (withPoll) {
  console.log("  iMessage is available: polls, tapbacks and effects should all work.");
  console.log("  Set UNSAID_POLL=1 once the poll looks right on the phone.");
} else {
  console.log("  Text delivers, the poll does not — so this is an SMS (green) delivery.");
  console.log("  Tapbacks and message effects are iMessage-only and will NOT work either.");
  console.log("  Confirm has to be a text reply, and the numbered list must stay the default.");
}
process.exit(0);
