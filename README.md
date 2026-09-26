# unsaid

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run

```sh
npm install
npm run start
```

## Unsaid — start here

Two lanes, split in `docs/`: **A** owns messaging and flow (Spectrum, router, join
link, orchestrator, Nessie); **B** owns agents, data and screen. Read
`docs/plan-teammate-a.md` or `docs/plan-teammate-b.md` for your own lane.

### Run B's lane right now

Neither of these needs an API key, an Atlas cluster, or Spectrum:

```sh
npm install
npm run harness    # three fake users -> a plan, plus 14 assertions
npm run backroom   # projector screen on http://localhost:4321
```

### For teammate A

`src/contracts.ts` is the shared contract file. Import the types from it rather
than redefining them — tonight the compiler is the only thing catching contract
drift between the two lanes. The seam you call is `handleDM` in `src/slots.ts`
(contract 2): hand it `{ planId, userId, text }` and it returns the resolved
slots, what is still missing, and the DM string to send back.

Two things that affect A's code:

- **`merged.window` is not a venue filter.** Venue records have no `hours` (demo
  scope is one evening), so the window is how A assigns each candidate's *time*.
  `filterVenues` applies budget, dietary and travel only.
- **Travel never reaches A.** `filterVenues` enforces it from home coordinates
  that stay inside B, and returns one unlabelled `longestTravelMin` per survivor
  for the "minimise the longest commute" tiebreak.

### Optional environment

Everything degrades rather than breaking. Without `XAI_API_KEY` the agents use
deterministic scoring and offline slot extraction; without `MONGODB_URI` the
store is in memory. See `.env.example`.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `src/index.ts` to replace the echo loop with real agent logic.
- Add more providers from `spectrum-ts/providers/*`.
