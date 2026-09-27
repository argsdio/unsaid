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
codes, orchestrator, Nessie); **B** owns agents, data and screen. Read
`docs/plan-teammate-a.md` or `docs/plan-teammate-b.md` for your own lane, and
`docs/negotiation-protocol.md` for the proposed multi-agent negotiation.

### Setup

```sh
git clone <this repo> && cd unsaid
npm install
cp .env.example .env     # then fill it in, see below
npm run harness          # verifies your setup: 54 assertions
npm run start            # runs the app
```

Fill `.env` with the values in the table below. **Two of these must match your
teammate's exactly:**

| Variable | Where from | Shared? |
|---|---|---|
| `PROJECT_ID`, `PROJECT_SECRET` | [Photon dashboard](https://app.photon.codes) → Settings | **yes, same project** |
| `MONGODB_URI`, `MONGODB_DB` | MongoDB Atlas → Connect → Drivers | **yes, same cluster** |
| `XAI_API_KEY` | xAI console | yes |

**Why the sharing matters.** The two lanes only meet through the database: A's
router writes plans and rounds, B's backroom screen reads them. Point them at
separate Atlas clusters and each half works perfectly alone while nothing works
together — with no error message to explain it.

**Only one person runs `npm run start`.** Two processes on the same `PROJECT_ID`
both receive every inbound message, so you get duplicate replies and doubled
writes. Decide who hosts the app; the other runs `npm run backroom`, which reads
the same database and needs no Spectrum connection.

Atlas gotchas: allowlist `0.0.0.0/0` under Network Access or connections hang
rather than failing, and URL-encode the password if it contains `@ : / ? #`.

### Run B's lane with nothing configured

Both work with no API key, no Atlas and no Spectrum — useful for checking out the
repo and confirming it is alive:

```sh
npm run harness    # three fake users -> a plan, plus assertions
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

### Degradation, and why it is quiet

Nothing crashes when a key is missing — behaviour just gets worse. Without
`XAI_API_KEY` the agents fall back to deterministic scoring and offline slot
extraction; without `MONGODB_URI` the store runs in memory and loses everything
on restart. Useful for development, dangerous to assume: check `npm run harness`
output, which states which store it used.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `src/index.ts` to replace the echo loop with real agent logic.
- Add more providers from `spectrum-ts/providers/*`.
