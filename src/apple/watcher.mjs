// Cloudflare-side restock watcher: a Durable Object that polls Apple on an
// alarm loop (default every ~30s), keeps restock state in DO storage and sends
// Telegram alerts. The Worker's cron (every minute) only makes sure the alarm
// loop is running.
//
// Config ([vars] in wrangler.toml):
//   WATCH_ENABLED       "1" (default) / "0"
//   WATCH_FAMILY        iphoneduo | iphone18promax | iphone18pro
//   WATCH_STORES        all | VIC | R180,R343 | store names
//   WATCH_CAPS          256gb,512gb (empty = any)
//   WATCH_COLORS        nightsky (empty = any)
//   WATCH_INTERVAL_SEC  seconds between checks, minimum 20
// Secrets (wrangler secret put / dashboard):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (comma separated)

import {
  APPLE_BASE,
  FAMILIES,
  STORE_BY_ID,
  describePart,
  pickAnchors,
  productUrl,
  resolveStores,
  selectParts
} from "./catalog-au.mjs";
import { scanStores } from "./fulfillment.mjs";
import { csv, groupByStore, landedMessage, sendTelegram } from "./notify.mjs";
import { createRestockTracker } from "./restock-state.mjs";

const MAX_BACKOFF_SEC = 15 * 60;
const BLOCKED_WARN_ROUNDS = 4;
const RECENT_LIMIT = 30;
const SOURCE = "Cloudflare watcher";

export function readWatchConfig(env = {}) {
  const family = String(env.WATCH_FAMILY || "iphoneduo").trim().toLowerCase();
  const caps = csv(env.WATCH_CAPS).map((v) => v.toLowerCase());
  const colors = csv(env.WATCH_COLORS).map((v) => v.toLowerCase());
  const stores = resolveStores(env.WATCH_STORES || "VIC");

  return {
    enabled: String(env.WATCH_ENABLED ?? "1") !== "0",
    family: FAMILIES[family] ? family : "iphoneduo",
    stores,
    caps,
    colors,
    parts: selectParts(FAMILIES[family] ? family : "iphoneduo", { caps, colors }),
    intervalSec: Math.max(20, Number(env.WATCH_INTERVAL_SEC) || 30),
    telegramToken: String(env.TELEGRAM_BOT_TOKEN || "").trim(),
    telegramChatIds: csv(env.TELEGRAM_CHAT_ID)
  };
}

function configKey(config) {
  return [config.family, config.stores.join(","), config.parts.join(",")].join("|");
}

export class AppleWatcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Tests inject a fake fetch; undefined means the global fetch.
    this.fetchImpl = undefined;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ensure") {
      const config = readWatchConfig(this.env);
      if (!config.enabled) {
        await this.state.storage.deleteAlarm();
        return Response.json({ ok: true, enabled: false });
      }
      const alarm = await this.state.storage.getAlarm();
      if (alarm === null) await this.state.storage.setAlarm(Date.now() + 1000);
      return Response.json({ ok: true, enabled: true, nextAlarm: alarm });
    }

    if (url.pathname === "/status") {
      const status = (await this.state.storage.get("status")) || null;
      const alarm = await this.state.storage.getAlarm();
      const config = readWatchConfig(this.env);
      return Response.json({
        ok: true,
        enabled: config.enabled,
        telegramConfigured: Boolean(config.telegramToken && config.telegramChatIds.length),
        nextCheckAt: alarm ? new Date(alarm).toISOString() : null,
        status
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm() {
    const config = readWatchConfig(this.env);
    if (!config.enabled) return;

    let delaySec = config.intervalSec;
    try {
      delaySec = await this.runOnce(config);
    } catch (err) {
      await this.state.storage.put("lastError", {
        at: new Date().toISOString(),
        message: err && err.message ? err.message : String(err)
      });
    } finally {
      // ±20% jitter so checks do not land on a fixed rhythm.
      const jittered = delaySec * (0.8 + Math.random() * 0.4);
      await this.state.storage.setAlarm(Date.now() + Math.round(jittered * 1000));
    }
  }

  // One check. Returns seconds until the next one.
  async runOnce(config, now = Date.now()) {
    const storage = this.state.storage;
    const saved = (await storage.get("watch")) || {};
    const key = configKey(config);
    const fresh = saved.configKey !== key;

    const watch = fresh
      ? { configKey: key, tracker: {}, blockedRounds: 0, warnedBlocked: false, recent: [] }
      : { blockedRounds: 0, warnedBlocked: false, recent: [], ...saved };

    if (fresh) {
      const fam = FAMILIES[config.family];
      await this.notify(config, {
        text:
          `👀 Cloudflare 开始监控 ${fam.name}\n` +
          `${config.stores.length} 家门店 · ${config.parts.length} 个配置 · 每 ~${config.intervalSec} 秒检查一次`
      });
    }

    const tracker = createRestockTracker({ initial: watch.tracker });
    const startedAt = Date.now();
    const scan = await scanStores(APPLE_BASE, config.parts, {
      anchors: pickAnchors(config.stores),
      targetStores: config.stores,
      fetchOptions: { fetchImpl: this.fetchImpl }
    });

    const base = {
      checkedAt: new Date(now).toISOString(),
      family: config.family,
      familyName: FAMILIES[config.family].name,
      stores: config.stores,
      parts: config.parts,
      requests: scan.requests,
      durationMs: Date.now() - startedAt,
      errors: scan.errors.slice(0, 5)
    };

    if (scan.blocked && scan.stores.size === 0) {
      watch.blockedRounds += 1;
      if (watch.blockedRounds >= BLOCKED_WARN_ROUNDS && !watch.warnedBlocked) {
        watch.warnedBlocked = true;
        await this.notify(config, {
          text:
            "⚠️ Apple 拒绝了 Cloudflare 的库存查询（" +
            `${(scan.errors[0] && scan.errors[0].status) || "blocked"}），正在降频重试。` +
            "如果一直这样，请改用本地脚本 agent/apple-agent.mjs。"
        });
      }
      await storage.put("watch", watch);
      const backoff = Math.min(MAX_BACKOFF_SEC, config.intervalSec * 2 ** watch.blockedRounds);
      await storage.put("status", { ...base, ok: false, blocked: true, blockedRounds: watch.blockedRounds, inStock: tracker.inStock(), recent: watch.recent, rows: [] });
      return backoff;
    }

    if (watch.warnedBlocked) {
      await this.notify(config, { text: "✅ Cloudflare 库存查询已恢复正常。" });
    }
    watch.blockedRounds = 0;
    watch.warnedBlocked = false;

    const { landed, soldOut } = tracker.update(scan.stores, config.stores, config.parts, now);

    for (const group of groupByStore(landed)) {
      await this.notify(config, landedMessage(group, { source: SOURCE }));
    }

    for (const item of landed) {
      watch.recent.unshift({ type: "landed", storeId: item.storeId, part: item.part, at: now });
    }
    for (const item of soldOut) {
      watch.recent.unshift({ type: "sold_out", storeId: item.storeId, part: item.part, at: now, durationSec: Math.round(item.durationMs / 1000) });
    }
    watch.recent = watch.recent.slice(0, RECENT_LIMIT);
    watch.tracker = tracker.toJSON();
    await storage.put("watch", watch);

    const inStock = tracker.inStock();
    const rows = config.stores.map((id) => {
      const meta = STORE_BY_ID[id];
      const found = scan.stores.get(id);
      const available = inStock
        .filter((row) => row.storeId === id)
        .map((row) => ({ ...describePart(row.part), since: new Date(row.since).toISOString(), url: productUrl(row.part) }));
      return {
        storeId: id,
        storeName: meta.name,
        city: meta.city,
        state: meta.state,
        status: !found ? "unknown" : !found.pickupEligible ? "no_pickup" : available.length ? "in_stock" : "sold_out",
        available
      };
    });

    await storage.put("status", { ...base, ok: true, blocked: false, blockedRounds: 0, inStock, recent: watch.recent, rows });
    return config.intervalSec;
  }

  async notify(config, message) {
    await sendTelegram(config.telegramToken, config.telegramChatIds, message, {
      fetchImpl: this.fetchImpl,
      log: (line) => console.log(line)
    });
  }
}
