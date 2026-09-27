# unsaid — agent instructions

This is a [Spectrum](https://photon.codes/docs/spectrum-ts) app, pinned to `spectrum-ts@^12.10.1`. The entry point is `src/index.ts`, which configures the imessage provider(s) and runs the echo loop.

## Working in this project

- Run the app with `npm run start`. **Only one person runs this at a time** — two processes on the same `PROJECT_ID` both receive every message.
- `npm run harness` runs teammate B's whole lane end to end plus its assertions. It is the fastest way to check nothing is broken, and it needs no phones.
- `npm run backroom` serves the projector screen on http://localhost:4321.
- Add providers by importing them in `src/index.ts` and listing them in the `Spectrum({ providers: [...] })` config.
- Outgoing message content uses the builders documented in the skill (text, attachment, voice, contact, richlink, poll, group, custom).

## Environment

This project reads secrets from `.env` (gitignored). **Do not read, write, or echo `.env`** — it contains credentials. `.env.example` lists every variable and is safe to read.

| Variable | Needed for | Without it |
|---|---|---|
| `PROJECT_ID` / `PROJECT_SECRET` | Spectrum Cloud | the app cannot start |
| `MONGODB_URI` / `MONGODB_DB` | shared state | the store runs in memory and dies on restart |
| `XAI_API_KEY` / `GROK_MODEL` | Grok | deterministic scoring and offline slot extraction |

**Both teammates must use the same `MONGODB_URI` and the same Photon project.** The two lanes only meet through the database: A's router writes plans and rounds, B's backroom screen reads them. Separate clusters means each half works alone and nothing works together, with no error to explain why.

Everything degrades rather than breaking, which also makes the failure quiet: a missing key produces worse behaviour, not a crash.

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## Managing the Spectrum Cloud project (CLI)

If this app uses a platform provider, the `PROJECT_ID` / `PROJECT_SECRET` in `.env` belong to a **Spectrum Cloud** project. To manage that project from the terminal — authenticate, rotate the secret, list the line(s) you send from, manage platforms/users, or create more projects — use the `photon-cli` skill (the `photon` CLI) from [`photon-hq/skills`](https://github.com/photon-hq/skills):

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

Common tasks once it's installed:

- `photon whoami` — confirm you're authenticated (run `photon login` if not).
- `photon projects regenerate-secret` — rotate the Spectrum API secret (then update `PROJECT_SECRET` in `.env`).
- `photon spectrum lines list` — see the line(s) your app sends from.
- `photon projects show` — inspect the active project (set `PHOTON_PROJECT_ID`, or pass `--project <id>`).

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
