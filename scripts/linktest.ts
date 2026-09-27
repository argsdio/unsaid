import "dotenv/config";
import { Spectrum, richlink } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { VENUES, mapsLink, transitLink } from "../src/venues.ts";

// Does a Google Maps link render as a preview card on a real phone, and which
// URL shape renders best? `richlink` is outbound-only: it carries just the URL
// and asks iMessage to unfurl it, so the answer can only come from a device.
//
//   npm run linktest -- +15551234567
const to = process.argv[2];
if (!to?.startsWith("+")) {
  console.error("Usage: npm run linktest -- +15551234567");
  process.exit(1);
}

const venue = VENUES.find((v) => v.placeId && v.name === "Hanoi House") ?? VENUES.find((v) => v.placeId)!;
const home = { lat: 40.7265, lng: -73.9815, label: "East Village" };

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});
const im = imessage(app);
const space = await im.space.get(`any;-;${to}`);

const shapes: Array<[string, string]> = [
  ["place_id (what the settled card uses)", mapsLink(venue)],
  ["plain coordinates", `https://maps.google.com/?q=${venue.lat},${venue.lng}`],
  ["name search", `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${venue.name} ${venue.neighborhood} New York`)}`],
  ["transit directions from East Village", transitLink(venue, home)],
];

async function probe(label: string, send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
    console.log(`  sent  ${label}`);
  } catch (err) {
    console.log(`  FAIL  ${label} — ${(err as Error).message.slice(0, 140)}`);
  }
}

console.log(`\nSending link tests for ${venue.name} to ${to}:`);
await probe("intro text", () =>
  space.send(`Unsaid link check — ${venue.name}. Four links follow: 1 place_id, 2 coordinates, 3 name search, 4 transit directions. Tell me which ones show a map preview.`),
);
for (const [i, [label, url]] of shapes.entries()) {
  await probe(`${i + 1}. richlink · ${label}`, () => space.send(richlink(url)));
}
// The same URL as plain text, to compare: iMessage may unfurl it anyway, in
// which case richlink buys nothing and the card can stay one message.
await probe("5. same place_id link as plain text", () => space.send(`5. plain text: ${mapsLink(venue)}`));

console.log("\nCheck the phone and tell me which of 1-5 rendered a preview card.");
process.exit(0);
