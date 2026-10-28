# stock-level
check stock level

- `/` — Officeworks stock by store (`/api/check`)
- `/apple` — Apple Store AU iPhone pickup availability (`/api/apple/check`, `/api/apple/config`, debug `/api/apple/raw`)
- `agent/` — local iPhone restock watcher with Telegram alerts, see [agent/README.md](agent/README.md)
- Design notes: [docs/apple-iphone-stock-design.md](docs/apple-iphone-stock-design.md)

Tests: `node --test test/*.test.mjs`
