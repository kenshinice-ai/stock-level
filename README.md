# stock-level
check stock level

- `/` — Officeworks stock by store (`/api/check`)
- `/apple` — Apple Store AU iPhone pickup availability (`/api/apple/check`, `/api/apple/config`, debug `/api/apple/raw`)
- `agent/` — local iPhone restock watcher with Telegram alerts, see [agent/README.md](agent/README.md)
- Design notes: [docs/apple-iphone-stock-design.md](docs/apple-iphone-stock-design.md)

Tests: `node --test test/*.test.mjs`

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
tag = "v1"
new_sqlite_classes = ["AppleWatcher"]

[vars]
WATCH_FAMILY = "iphoneduo"
WATCH_STORES = "VIC"
WATCH_INTERVAL_SEC = "30"
```

then set the `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets and open `/api/apple/watch` to see its status.
