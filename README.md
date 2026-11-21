# Life

A personal chief-of-staff. It knows your goals, projects, uni work, shifts and plans. It breaks
them into small concrete steps and gives you **one clear to-do list for today**. A calendar runs
underneath and keeps re-planning as your week changes. It organises and reminds you; it never acts
on your behalf.

```
 Connectors ──► Signals ──► Triage (cheap model) ──► Proposed changes ──► Review / auto-apply
 Moodle iCal · timetable · Google Calendar · Gmail ×2 · Notion · Discord · screenshots · chat · Telegram
                                                   │
                     Deterministic scheduler (no AI) ──► Today list + "Life – Plan" calendar
                     Check-ins ──► push / Telegram ──► re-flow
                     Memory (Eunomia or built-in) ◄──► agents
```

## What's here

| Path | What it is |
|---|---|
| `packages/core` | Domain model. Locks (`hard/soft/flexible`), certainty (`confirmed/likely/maybe/unknown-time`), partial progress, and revertible `Change`s. |
| `packages/scheduler` | The planner. Back-schedules work from deadlines, keeps slack, plans around half-confirmed events, handles day modes (sick, low energy...), and reports overload as choices instead of cramming. Builds the Today list, the close-out, the "fresh start" after time away, and gentle check-ins. Pure TypeScript with unit tests. |
| `apps/server` | Fastify API on Postgres (or embedded PGlite for dev). Includes the review queue and undo, the chat and triage agents on the Claude API with a monthly spend cap, the connectors, notifications, the weekly review flow, and background jobs. |
| `apps/app` | Expo Router app, built today as an installable PWA. The same code becomes a native iPhone app later. |
| `infra` | `docker-compose.yml` with Postgres, Life, Caddy (HTTPS) and nightly backups. |
| `e2e/smoke.cjs` | Browser end-to-end check (iPhone viewport). |

## Design rules

- **The list is the product.** Today has five sections. Now / Next is the one thing to do right now. Must is deadlines and locked plans. Should is work planned into your day. Could is quick wins. Waiting on is what others owe you. Each item has a one-line "why today".
  - Swipe right = done, swipe left = tomorrow.
  - Tap or long-press for: half done, 30 minutes, next week, break down, I'm stuck, must today, drop.
  - Reorder feeds your priorities back into the plan.
- **Change is normal.** Everything is `flexible` unless you lock it. Plans can be "maybe" or have no time yet; the planner leaves room around them and asks you only when the answer starts to matter.
- **Re-planning costs nothing.** The scheduler is deterministic code. It re-runs after every change and every 5 minutes, without any AI calls.
- **Slack is built in.** It plans about 65% of your free time by default, and finishes work before deadlines with a buffer.
- **Kind, not naggy.**
  - Check-ins back off after two ignored ones in a row.
  - Nothing is sent during quiet hours.
  - There are no guilt counters.
  - An evening close-out takes one tap per item.
- **Everything is undoable.** Chat turns, connector imports and automatic moves all have Undo.
- **AI is only used for understanding**: triage, chat and breakdown. A hard monthly cap (`LIFE_MONTHLY_BUDGET_USD`) applies. Planning keeps working when the cap is hit or no API key is set.

## Run it locally (2 minutes, no setup)

```bash
pnpm install
```

```bash
LIFE_DATA_DIR=./data-demo pnpm --filter @life/server seed
```

```bash
pnpm --filter @life/app build:web
```

```bash
LIFE_APP_DIR=../app/dist LIFE_DATA_DIR=./data-demo pnpm --filter @life/server start
```

Open http://localhost:8787. The demo data is generated relative to now. For chat, add
`ANTHROPIC_API_KEY` to a root `.env` (copy `.env.example`).

For app development with hot reload, run `pnpm dev:server` and `pnpm --filter @life/app web`.
Set `EXPO_PUBLIC_API_URL=http://localhost:8787` for the dev server.

Tests:

```bash
pnpm test
```

```bash
node e2e/smoke.cjs http://localhost:8787
```

## Deploy (VPS now, homelab later)

1. Get a small VPS (e.g. Hetzner CX22, ~€4/month) and a domain or subdomain pointing at it.
2. Copy `.env.example` to `infra/.env` and fill it in. At minimum set `LIFE_DOMAIN`, `POSTGRES_PASSWORD`, `LIFE_API_TOKEN` and `ANTHROPIC_API_KEY`.
3. Start the stack:

   ```bash
   cd infra && docker compose up -d --build
   ```

4. On your iPhone, open `https://LIFE_DOMAIN` in Safari, tap **Share → Add to Home Screen**, and open Life from the home screen.
5. In **Settings → Server**, paste your token. Then tap **Turn on notifications here**.

Moving to the homelab later: copy `infra/` with your `.env`, restore the latest dump from
`infra/backups`, and run `docker compose up -d`.

## Connecting your life

| Source | How |
|---|---|
| **Moodle** (assignments, quizzes) | In Moodle: Calendar → Import or export calendars → Export → All courses → Get calendar URL. Paste it in Settings → Add feed → `moodle`. Deadlines become uni tasks with due dates. Re-syncs every 30 minutes. |
| **Timetable** | Your timetable's iCal or subscribe link → Add feed → `timetable`, and choose the lock. |
| **Google Calendar + Gmail** | Create an OAuth client in Google Cloud (Web app), with redirect `https://LIFE_DOMAIN/api/connect/google/callback`. Enable the Calendar and Gmail APIs and set `GOOGLE_CLIENT_ID/SECRET`. Then use Settings → Connect personal / Connect Monash (Monash signs in through Okta). Life reads your calendar and writes planned work blocks to a separate **"Life – Plan"** calendar, so your main calendar stays clean. |
| **Monash email** (if Monash blocks third-party apps) | In Monash Gmail, add a filter that forwards everything to your personal Gmail. Life reads it from there. |
| **Notion** (team action items) | Create an integration at notion.so/my-integrations. A workspace owner may need to approve it. Share the action-items database with it and set `NOTION_TOKEN`. Then in Settings enter the database ID, your name, and the assignee and due property names. Items assigned to you become tasks linked back to Notion. Marking them done in Notion marks them done here. |
| **Discord** (team server) | Create a bot at discord.com/developers, enable the **Message Content** intent, and set `DISCORD_BOT_TOKEN`. A server admin invites it. In Settings, list the channel IDs it may read, your user ID and your names. Mentions and asks are batched into one triage call every 30 minutes. DMs to the bot are quick capture. (Automating your own account breaks Discord's rules, so a bot is the only safe option.) |
| **iMessage / Instagram / WhatsApp** | There's no API without a Mac. Use the **weekly admin hour**: it asks for screenshots of the chats that matter, and vision pulls out plans and promises for you to confirm. In between, just tell Life in chat. If the homelab becomes a Mac mini, a BlueBubbles / `chat.db` connector can be added. |
| **Claude conversations** | Planned next: Life's tool layer exposed as a remote MCP connector for claude.ai. |
| **Telegram** (reliable nudges + capture) | Create a bot with @BotFather and set `TELEGRAM_BOT_TOKEN`. Message it once, then set `TELEGRAM_CHAT_ID` (get it from `https://api.telegram.org/bot<TOKEN>/getUpdates`). Check-in buttons work from Telegram, and you can text it things like "dinner moved to 8". |

## Notifications

- **Web push**: generate keys with `npx web-push generate-vapid-keys` and put them in `.env`. iOS only delivers web push to home-screen apps (iOS 16.4+).
- **Telegram** is the backup channel, because iOS web push can be flaky.
- What gets sent:
  - a morning brief around 7:30 (your musts plus the first action)
  - a check-in when each planned block starts (On it / Doing something else / +30m)
  - an evening close-out around 21:00

## Memory and cost

Memory stores durable facts only: people, preferences, project state and patterns. Raw emails are never stored.

**Built-in memory** is used by default: keyword recall stored in Postgres.

**[Eunomia](https://github.com/Qyrhal/Eunomia)** can be used instead:
1. Run its Docker stack.
2. Create a personal access token with the `memory:read` and `memory:write` scopes.
3. Set `EUNOMIA_URL` and `EUNOMIA_TOKEN`.

To keep Eunomia's own credit use near zero:
- Leave Eunomia's server chat model unset (`OPENAI_CHAT_MODEL` and the per-user setting). That turns off its per-record extraction, consolidation and supersession LLM jobs, which are the expensive part. Its recall still works (keyword + full text + graph).
- Don't connect Eunomia's own connectors. Life already triages Gmail and the rest once.
- Optional: point its embeddings at `text-embedding-3-small` (1536-dim) for semantic recall. That costs pennies a month.

Life also always passes `max_tokens` on recall.

**Expected monthly cost** is about $15–20:
- VPS: ~$5
- Claude API: ~$5–10. The cap is enforced. Haiku 5.5 handles triage, Sonnet 5.5 handles chat and planning, and the system prompt is cached. Noise is filtered before any AI call.
- Apple Developer: $8/month equivalent, only once you go native.

`LIFE_LLM_PROVIDER=claude-cli` uses `claude -p` signed into your Claude plan for text-only jobs. That counts against your subscription limits rather than API credit.

## Going native later

`apps/app` is a normal Expo app. With an Apple Developer account:

```bash
cd apps/app && npx eas-cli@latest build -p ios
```

Set `EXPO_PUBLIC_API_URL` to your server for the native build. Next on that path: native push and home-screen widgets for the Today list.

## Roadmap

- MCP server so claude.ai can read and update your plan, plus import of your Claude data export
- Drag-to-reorder (currently a reorder mode with ↑/↓)
- Passkey login (currently a single bearer token)
- Native iOS build with widgets
- iMessage via a Mac-mini homelab
- Notion write-back
- Richer Moodle details via its web-service API
