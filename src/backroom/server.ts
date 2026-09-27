// Without this the screen silently runs on the in-memory store and shows the
// seeded rounds forever, however well Atlas is configured.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { openStore } from "../db.ts";
import { DEMO_PLAN_ID, DEMO_ROUNDS } from "./fixtures.ts";
import { buildState } from "./state.ts";

const PORT = Number(process.env.BACKROOM_PORT ?? 4321);
const PAGE = new URL("./page.html", import.meta.url);

const store = await openStore();
console.log(
  process.env.MONGODB_URI
    ? "store: mongodb — the screen follows the live plan"
    : "store: memory (set MONGODB_URI to see real negotiations)",
);

// Seeded only when the store is empty, so a real orchestrator run is never
// overwritten but `npm run backroom` still shows something immediately.
if ((await store.listRounds(DEMO_PLAN_ID)).length === 0) {
  for (const round of DEMO_ROUNDS) await store.appendRound(round);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/state") {
    // No planId means "whatever is being negotiated now", resolved per request
    // so the screen picks up a plan that starts after it did.
    const planId =
      url.searchParams.get("planId") ??
      (await store.latestRoundPlanId([DEMO_PLAN_ID])) ??
      DEMO_PLAN_ID;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(await buildState(store, planId)));
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(PAGE, "utf8"));
    return;
  }

  res.writeHead(404).end("not found");
}).listen(PORT, () => {
  console.log(`backroom screen  http://localhost:${PORT}`);
});
