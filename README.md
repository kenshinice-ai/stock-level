# stock-level
check stock level

- `/` — Officeworks stock by store (`/api/check`, `/api/search`, `/api/stores`) with Telegram restock alerts (`/api/alerts`)
- `/apple` — Apple Store AU iPhone pickup availability (`/api/apple/check`, `/api/apple/config`, debug `/api/apple/raw`)
- `agent/` — local iPhone restock watcher with Telegram alerts, see [agent/README.md](agent/README.md)
- Design notes: [docs/apple-iphone-stock-design.md](docs/apple-iphone-stock-design.md)

Tests: `node --no-warnings --test test/*.test.mjs` (Node 22+, uses the built-in `node:sqlite`)

## Officeworks restock alerts (Telegram)

On the results page, **🔔 Restock alert** watches the nearest stores without stock (or one store via its 🔔 button).
The page gives a `t.me/<bot>?start=<id>` link; tapping **Start** in Telegram turns the alert on. A cron
(`*/5 * * * *`) re-checks watched stores and the bot messages when a store goes from no stock to in stock.
Alerts last 30 days; `/list` and the Stop buttons in Telegram turn them off.

Everything lives in one Durable Object with SQLite storage (`src/officeworks/watch-hub.mjs`), so no D1/KV
database needs to be created. One-time setup after deploying:

1. Create a bot with @BotFather (or reuse one). A bot can only have one webhook, so a bot used here stops
   working with `agent/apple-agent.mjs --telegram-setup` (getUpdates).
2. Add two **secrets** to the Worker (Dashboard → Workers → stock-level → Settings → Variables and Secrets):
   - `TELEGRAM_BOT_TOKEN` – the token from BotFather
   - `TELEGRAM_WEBHOOK_SECRET` – any random string of 16+ letters/digits/`_`/`-`
3. Open `https://<your-worker>/api/telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>` once. It registers the
   webhook and returns the bot username; the 🔔 buttons appear on the page after that.

Limits: 10 stores per alert, 20 alerts per Telegram chat, 300 active alerts in total, 30 store checks per
cron run (Workers free plan allows 50 subrequests per invocation).

## Cloudflare watcher (off by default)

`src/apple/watcher.mjs` is a Durable Object that polls Apple on an alarm loop and sends Telegram alerts,
kept alive by a 1-minute cron. It is **not enabled** because Apple answers Cloudflare Worker requests
with HTTP 541 (verified 2026-10-28 on the production worker via `/api/apple/raw`). Use the local agent instead.

To try it again later, check `/api/apple/raw?store=R180` first; if it returns `ok: true`, add to `wrangler.toml`:

```toml
[triggers]
crons = ["* * * * *"]

[[durable_objects.bindings]]
name = "APPLE_WATCHER"
class_name = "AppleWatcher"

[[migrations]]
tag = "v2"
new_sqlite_classes = ["AppleWatcher"]

[vars]
WATCH_FAMILY = "iphoneduo"
WATCH_STORES = "VIC"
WATCH_INTERVAL_SEC = "30"
```

(merge the cron into the existing `[triggers]` list; tag `v1` is already used by `WatchHub`),
then set the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets and open `/api/apple/watch` to see its status.
