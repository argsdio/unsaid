import "dotenv/config";
import { Spectrum, option, poll } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

// One-shot: sends a real poll to one phone so its rendering can be checked on a
// device. Nothing here touches the store or any plan.
//
//   npm run polltest -- +15551234567
const to = process.argv[2];
if (!to?.startsWith("+")) {
  console.error('Usage: npm run polltest -- +15551234567   (E.164, with the "+")');
  process.exit(1);
}

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);

try {
  const space = await im.space.get(to, { phone: to });
  console.log(`space ok for ${to}`);

  const card = poll(
    "Tonight at 7:00 PM — which one?",
    option("Xi'an Famous Foods · $14"),
    option("Superiority Burger · $17"),
    option("Mighty Quinn's BBQ · $20"),
  );
  await space.send(card);
  console.log("poll sent — check the phone. Tap an option and the reply should arrive below.");

  // Listen briefly so an inbound vote proves the round trip.
  const stop = setTimeout(() => {
    console.log("no vote within 90s; stopping.");
    process.exit(0);
  }, 90_000);

  for await (const [, message] of app.messages) {
    if (message.direction === "outbound") continue;
    console.log("inbound:", message.content.type, JSON.stringify(message.content).slice(0, 220));
    if (message.content.type === "poll_option") {
      console.log("POLL VOTE RECEIVED — the round trip works.");
      clearTimeout(stop);
      process.exit(0);
    }
  }
} catch (err) {
  console.error("failed:", (err as Error).message);
  console.error("If this is an allowlist error, the phone must be a registered project user on Pro.");
  process.exit(1);
}
