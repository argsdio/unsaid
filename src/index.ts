import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";
import { openStore } from "./db.ts";
import { routeMessage } from "./router.ts";

const store = await openStore();
console.log(
  process.env.MONGODB_URI ? "store: mongodb" : "store: memory (set MONGODB_URI to persist joins)",
);

const app = await Spectrum({
  projectId: process.env.PROJECT_ID!,
  projectSecret: process.env.PROJECT_SECRET!,
  providers: [imessage.config()],
});

const im = imessage(app);

for await (const [space, message] of app.messages) {
  await routeMessage(space, message, store, im.space);
}
