# Unsaid

An iMessage agent that collects dinner constraints in **private 1:1 chats**, then proposes a spot that works for everyone. Unsaid is **not** in the group thread: the host pastes a join code, each person texts the bot separately.

Built with [Photon Spectrum](https://photon.codes/docs/spectrum-ts) (`spectrum-ts`).

## What it does

- Host texts a plan (e.g. Friday dinner). Everyone else sends `JOIN ABCD`.
- Each person answers location, time, travel, diet, and budget in their own DM.
- **Nessie** (optional) suggests a budget from dinner-like purchases; people can accept or override.
- **Grok** (optional) parses messy replies and scores venues; without a key, extraction and ranking stay deterministic.
- `go` (host) negotiates a shortlist. Several options go out as an iMessage poll plus a numbered list; one option is a settle card.
- The winner is fanned to every DM, with a Google Maps pin and transit from that person’s home.

Google **Places** is used only when regenerating `src/venues.json` (`npm run venues`). Runtime never calls Places.

## Setup

```sh
git clone https://github.com/argsdio/unsaid.git
cd unsaid
npm install
cp .env.example .env
```

Fill `.env` (never commit it):

| Variable | Needed for | Without it |
|---|---|---|
| `PROJECT_ID` / `PROJECT_SECRET` | [Photon dashboard](https://app.photon.codes) — iMessage | the app cannot start |
| `MONGODB_URI` / `MONGODB_DB` | shared plans across restarts | in-memory store; joins die on restart |
| `XAI_API_KEY` / `GROK_MODEL` | Grok | offline extraction and scoring |
| `NESSIE_API_KEY` | live Nessie sandbox (`https://api.nessieisreal.com`) | seeded dinner ledgers, still labeled Nessie |
| `GOOGLE_PLACES_API_KEY` | `npm run venues` only | unused at runtime |

If several people share one bot, they must use the **same Photon project and the same MongoDB**. Two `npm run start` processes on the same `PROJECT_ID` both receive every message — run **one** Spectrum process. Atlas: allowlist `0.0.0.0/0` if connections hang; URL-encode passwords that contain `@ : / ? #`.

## Run

```sh
npm run harness    # end-to-end checks, no phones
npm run start      # iMessage bot
npm run backroom   # projector UI at http://localhost:4321 (reads Mongo)
```

`forget me` wipes that person’s stored profile for a demo reset.

## Links

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [Photon dashboard](https://app.photon.codes)
