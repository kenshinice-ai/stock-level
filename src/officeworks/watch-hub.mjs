// Officeworks restock alerts over Telegram.
//
// A single Durable Object (SQLite storage) holds every watch: one product SKU
// at up to MAX_STORES_PER_WATCH stores, linked to one Telegram chat. The
// Worker's cron calls /run every few minutes; each run re-checks the
// least-recently-checked (sku, store) pairs and messages the chat when a
// store goes from "no stock" to "in stock".
//
// Flow: the page POSTs /create -> gets a t.me deep link -> the person taps
// Start in Telegram -> the bot webhook (/telegram) links that chat.
//
// Env: TELEGRAM_BOT_TOKEN (secret), TELEGRAM_WEBHOOK_SECRET (secret),
// TELEGRAM_API_BASE (optional, a local Bot API stand-in for testing).

import { escapeHtml, sendTelegram, telegramApi } from "../lib/telegram.mjs";
import { fetchAvailabilityRaw, mapLimit, parseCurrentAvailability } from "./client.mjs";

// Workers allow 50 subrequests per invocation on the free plan; keep room
// for Telegram messages.
export const MAX_CHECKS_PER_RUN = 30;
export const MAX_STORES_PER_WATCH = 10;
export const MAX_WATCHES_PER_CHAT = 20;
export const MAX_ACTIVE_WATCHES = 300;
const RECHECK_MS = 4 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const WATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const TEXT = {
  en: {
    linked: (w, n) => `🔔 Watching <b>${w}</b> at ${n} store(s). I'll message you when it's back in stock. Expires in 30 days.`,
    nowIn: "Already in stock now:",
    noneIn: "None of these stores has it right now.",
    landed: (w) => `🟢 <b>${w}</b> is back in stock:`,
    open: "Open on Officeworks",
    stop: "Stop this alert",
    stopAll: "Stop all alerts",
    stopped: "Alert stopped.",
    stoppedAll: (n) => `Stopped ${n} alert(s).`,
    expired: "This alert link has expired. Create a new one on the website.",
    limit: `You already have ${MAX_WATCHES_PER_CHAT} active alerts. Stop one with /list first.`,
    help: "Create an alert on the stock checker page (🔔 button), then tap the Telegram link it gives you.\n/list – your alerts",
    none: "You have no active alerts.",
    list: "Your active alerts:",
    watchExpired: (w) => `⌛ Your alert for <b>${w}</b> has expired. Create a new one if you still need it.`,
    inStore: "in store",
    collect: "C&C"
  },
  zh: {
    linked: (w, n) => `🔔 已开始监控 <b>${w}</b>（${n} 家门店），到货会马上通知你。30 天后自动结束。`,
    nowIn: "这些门店现在就有货：",
    noneIn: "这些门店目前都没货，补货时会通知你。",
    landed: (w) => `🟢 <b>${w}</b> 到货了：`,
    open: "在 Officeworks 查看",
    stop: "停止这个提醒",
    stopAll: "停止全部提醒",
    stopped: "已停止提醒。",
    stoppedAll: (n) => `已停止 ${n} 个提醒。`,
    expired: "这个提醒链接已过期，请回网页重新创建。",
    limit: `你已经有 ${MAX_WATCHES_PER_CHAT} 个提醒了，请先用 /list 停掉一些。`,
    help: "在库存查询网页上点 🔔 到货提醒，然后点它给你的 Telegram 链接即可。\n/list – 查看我的提醒",
    none: "你目前没有提醒。",
    list: "你的提醒：",
    watchExpired: (w) => `⌛ <b>${w}</b> 的到货提醒已到期结束。还需要的话请重新创建。`,
    inStore: "店内",
    collect: "C&C 自提"
  }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_url TEXT NOT NULL DEFAULT '',
  min_qty INTEGER NOT NULL DEFAULT 1,
  lang TEXT NOT NULL DEFAULT 'en',
  chat_id INTEGER,
  created_at INTEGER NOT NULL,
  linked_at INTEGER,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS watch_stores (
  watch_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  postcode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  qty INTEGER,
  in_store INTEGER,
  click_collect INTEGER,
  checked_at INTEGER,
  alerted_at INTEGER,
  PRIMARY KEY (watch_id, store_id)
);
CREATE INDEX IF NOT EXISTS idx_watches_chat ON watches(chat_id, active);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export class WatchHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(SCHEMA);
    // Tests inject a fake fetch; undefined means the global fetch.
    this.fetchImpl = undefined;
    this.now = () => Date.now();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

    try {
      switch (url.pathname) {
        case "/config":
          return Response.json({ ok: true, enabled: this.enabled(), botUsername: this.meta("bot_username") });
        case "/create":
          return Response.json(await this.create(body));
        case "/watch":
          return Response.json(this.describe(url.searchParams.get("id")));
        case "/telegram":
          await this.onTelegram(body);
          return Response.json({ ok: true });
        case "/run":
          return Response.json(await this.run());
        case "/setup":
          return Response.json(await this.setup(body.origin));
        default:
          return Response.json({ ok: false, error: "Not found" }, { status: 404 });
      }
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      return Response.json({ ok: false, error: err && err.message ? err.message : String(err) }, { status });
    }
  }

  enabled() {
    return Boolean(this.env && this.env.TELEGRAM_BOT_TOKEN);
  }

  meta(key) {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ------------------------------------------------------------ create

  async create(input) {
    if (!this.enabled()) throw httpError(503, "Alerts are not configured");
    const botUsername = this.meta("bot_username");
    if (!botUsername) throw httpError(503, "Telegram bot is not set up yet (run /api/telegram/setup)");

    const sku = String(input.sku || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{4,30}$/.test(sku)) throw httpError(400, "Invalid sku");

    const stores = (Array.isArray(input.stores) ? input.stores : [])
      .map((s) => ({
        id: String((s && s.storeId) || "").toUpperCase(),
        name: cleanText((s && s.storeName) || "", 80),
        postcode: String((s && s.postcode) || "")
      }))
      .filter((s) => /^[A-Z]\d{2,5}$/.test(s.id) && /^\d{4}$/.test(s.postcode))
      .filter((s, i, all) => all.findIndex((o) => o.id === s.id) === i)
      .slice(0, MAX_STORES_PER_WATCH);
    if (!stores.length) throw httpError(400, "No valid stores");

    const active = this.sql.exec("SELECT COUNT(*) AS n FROM watches WHERE active = 1").one().n;
    if (active >= MAX_ACTIVE_WATCHES) throw httpError(429, "Too many active alerts, try again later");

    const now = this.now();
    const id = randomId();
    const productUrl = /^https:\/\/www\.officeworks\.com\.au\//.test(String(input.productUrl || "")) ? String(input.productUrl) : "";

    this.sql.exec(
      "INSERT INTO watches (id, sku, product_name, product_url, min_qty, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      sku,
      cleanText(input.productName || sku, 120),
      productUrl,
      clamp(Number(input.minQty) || 1, 1, 50),
      input.lang === "zh" ? "zh" : "en",
      now
    );
    for (const store of stores) {
      this.sql.exec(
        "INSERT INTO watch_stores (watch_id, store_id, store_name, postcode) VALUES (?, ?, ?, ?)",
        id,
        store.id,
        store.name || store.id,
        store.postcode
      );
    }

    return { ok: true, id, startUrl: `https://t.me/${botUsername}?start=${id}`, stores: stores.length };
  }

  describe(id) {
    const watch = this.sql.exec("SELECT * FROM watches WHERE id = ?", String(id || "")).toArray()[0];
    if (!watch) return { ok: false, error: "Not found" };
    const stores = this.sql
      .exec("SELECT store_id, store_name, status, qty, checked_at FROM watch_stores WHERE watch_id = ?", watch.id)
      .toArray();
    return {
      ok: true,
      id: watch.id,
      sku: watch.sku,
      productName: watch.product_name,
      linked: watch.chat_id !== null,
      active: watch.active === 1,
      expiresAt: watch.expires_at,
      stores
    };
  }

  // ------------------------------------------------------------ telegram

  async onTelegram(update) {
    if (update.callback_query) return this.onCallback(update.callback_query);

    const message = update.message;
    if (!message || !message.chat || typeof message.text !== "string") return;
    const chatId = message.chat.id;
    const lang = String((message.from && message.from.language_code) || "").startsWith("zh") ? "zh" : "en";
    const [command, arg] = message.text.trim().split(/\s+/, 2);

    if (command === "/start" && arg) return this.link(chatId, arg, lang);
    if (command === "/list") return this.list(chatId, lang);
    if (command === "/stop") return this.stopAll(chatId, lang);
    return this.send(chatId, TEXT[lang].help);
  }

  async link(chatId, id, lang) {
    const t = TEXT[lang];
    const watch = this.sql.exec("SELECT * FROM watches WHERE id = ?", id).toArray()[0];
    const now = this.now();

    if (!watch || watch.active !== 1 || (watch.chat_id === null && now - watch.created_at > PENDING_TTL_MS)) {
      return this.send(chatId, t.expired);
    }
    if (watch.chat_id !== null && watch.chat_id !== chatId) return this.send(chatId, t.expired);

    if (watch.chat_id === null) {
      const count = this.sql
        .exec("SELECT COUNT(*) AS n FROM watches WHERE chat_id = ? AND active = 1", chatId)
        .one().n;
      if (count >= MAX_WATCHES_PER_CHAT) return this.send(chatId, t.limit);

      this.sql.exec(
        "UPDATE watches SET chat_id = ?, linked_at = ?, expires_at = ?, lang = ? WHERE id = ?",
        chatId,
        now,
        now + WATCH_TTL_MS,
        lang,
        id
      );
    }

    const linked = { ...watch, chat_id: chatId, lang };
    const stores = this.sql.exec("SELECT * FROM watch_stores WHERE watch_id = ?", id).toArray();
    await this.send(chatId, t.linked(escapeHtml(linked.product_name), stores.length), this.watchButtons(linked));

    // Check straight away so the person knows where it stands today.
    const results = await this.checkPairs(stores.map((s) => ({ sku: linked.sku, store_id: s.store_id, postcode: s.postcode })));
    const inStock = [];
    for (const store of stores) {
      const result = results.get(`${linked.sku}|${store.store_id}`);
      if (!result) continue;
      const status = result.qty >= linked.min_qty ? "in" : "out";
      this.saveStoreState(id, store.store_id, status, result, status === "in" ? now : null);
      if (status === "in") inStock.push({ ...store, ...result });
    }
    await this.send(chatId, inStock.length ? `${t.nowIn}\n${this.storeLines(inStock, t)}` : t.noneIn);
  }

  async list(chatId, lang) {
    const t = TEXT[lang];
    const watches = this.sql
      .exec("SELECT * FROM watches WHERE chat_id = ? AND active = 1 ORDER BY linked_at DESC", chatId)
      .toArray();
    if (!watches.length) return this.send(chatId, t.none);

    const rows = watches.map((w) => [{ text: `✖ ${w.product_name}`.slice(0, 60), callback_data: `stop:${w.id}` }]);
    rows.push([{ text: t.stopAll, callback_data: "stopall" }]);
    return this.send(chatId, t.list, rows);
  }

  async stopAll(chatId, lang) {
    const n = this.sql.exec("UPDATE watches SET active = 0 WHERE chat_id = ? AND active = 1", chatId).rowsWritten;
    return this.send(chatId, TEXT[lang].stoppedAll(n || 0));
  }

  async onCallback(query) {
    const chatId = query.message && query.message.chat && query.message.chat.id;
    const lang = String((query.from && query.from.language_code) || "").startsWith("zh") ? "zh" : "en";
    const data = String(query.data || "");

    await telegramApi(this.env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: query.id }, this.tgOptions());
    if (!chatId) return;

    if (data === "stopall") return this.stopAll(chatId, lang);
    if (data.startsWith("stop:")) {
      this.sql.exec("UPDATE watches SET active = 0 WHERE id = ? AND chat_id = ?", data.slice(5), chatId);
      return this.send(chatId, TEXT[lang].stopped);
    }
  }

  // ------------------------------------------------------------ run

  async run() {
    const now = this.now();
    const expiredNotices = this.expire(now);

    const pairs = this.sql
      .exec(
        `SELECT w.sku AS sku, ws.store_id AS store_id, MAX(ws.postcode) AS postcode,
                MIN(COALESCE(ws.checked_at, 0)) AS last_checked
           FROM watch_stores ws JOIN watches w ON w.id = ws.watch_id
          WHERE w.active = 1 AND w.chat_id IS NOT NULL
          GROUP BY w.sku, ws.store_id
          HAVING MIN(COALESCE(ws.checked_at, 0)) < ?
          ORDER BY last_checked ASC
          LIMIT ?`,
        now - RECHECK_MS,
        MAX_CHECKS_PER_RUN
      )
      .toArray();

    const results = await this.checkPairs(pairs);

    // Per watch: stores that just came into stock.
    const landed = new Map();
    for (const [key, result] of results) {
      const [sku, storeId] = key.split("|");
      const rows = this.sql
        .exec(
          `SELECT w.id, w.chat_id, w.min_qty, ws.status, ws.store_name
             FROM watch_stores ws JOIN watches w ON w.id = ws.watch_id
            WHERE w.active = 1 AND w.chat_id IS NOT NULL AND w.sku = ? AND ws.store_id = ?`,
          sku,
          storeId
        )
        .toArray();

      for (const row of rows) {
        const status = result.qty >= row.min_qty ? "in" : "out";
        const isNew = status === "in" && row.status !== "in";
        this.saveStoreState(row.id, storeId, status, result, isNew ? now : null);
        if (isNew) {
          if (!landed.has(row.id)) landed.set(row.id, []);
          landed.get(row.id).push({ store_id: storeId, store_name: row.store_name, ...result });
        }
      }
    }

    let alerts = 0;
    for (const [watchId, stores] of landed) {
      const watch = this.sql.exec("SELECT * FROM watches WHERE id = ?", watchId).one();
      const t = TEXT[watch.lang] || TEXT.en;
      await this.send(
        watch.chat_id,
        `${t.landed(escapeHtml(watch.product_name))}\n${this.storeLines(stores, t)}`,
        this.watchButtons(watch)
      );
      alerts += 1;
    }

    for (const notice of expiredNotices) {
      const t = TEXT[notice.lang] || TEXT.en;
      await this.send(notice.chat_id, t.watchExpired(escapeHtml(notice.product_name)));
    }

    return { ok: true, checked: results.size, pairs: pairs.length, alerts, expired: expiredNotices.length };
  }

  // Deactivates stale pending links and expired watches; returns watches whose
  // owner should hear that they expired.
  expire(now) {
    const notices = this.sql
      .exec("SELECT id, chat_id, lang, product_name FROM watches WHERE active = 1 AND chat_id IS NOT NULL AND expires_at < ?", now)
      .toArray();
    this.sql.exec(
      "UPDATE watches SET active = 0 WHERE active = 1 AND ((chat_id IS NULL AND created_at < ?) OR expires_at < ?)",
      now - PENDING_TTL_MS,
      now
    );
    // Inactive watches are kept a week past their end so status links still work.
    const stale = now - PURGE_AFTER_MS;
    const ended = "active = 0 AND COALESCE(expires_at, created_at + " + PENDING_TTL_MS + ") < ?";
    this.sql.exec(`DELETE FROM watch_stores WHERE watch_id IN (SELECT id FROM watches WHERE ${ended})`, stale);
    this.sql.exec(`DELETE FROM watches WHERE ${ended}`, stale);
    return notices;
  }

  // Fresh availability for (sku, store) pairs -> Map("sku|store" -> result).
  async checkPairs(pairs) {
    const results = new Map();
    await mapLimit(pairs, 4, async (pair) => {
      try {
        const raw = await fetchAvailabilityRaw(pair.store_id, pair.postcode, pair.sku, {
          cache: false,
          fetchImpl: this.fetchImpl
        });
        const parsed = parseCurrentAvailability(raw, pair.sku);
        results.set(`${pair.sku}|${pair.store_id}`, {
          qty: parsed.qty,
          inStore: parsed.inStoreQuantity,
          clickCollect: parsed.clickAndCollectQuantity
        });
      } catch {
        // Leave the pair unchecked; it stays first in line for the next run.
      }
    });
    return results;
  }

  saveStoreState(watchId, storeId, status, result, alertedAt) {
    this.sql.exec(
      `UPDATE watch_stores
          SET status = ?, qty = ?, in_store = ?, click_collect = ?, checked_at = ?,
              alerted_at = COALESCE(?, alerted_at)
        WHERE watch_id = ? AND store_id = ?`,
      status,
      result.qty,
      result.inStore,
      result.clickCollect,
      this.now(),
      alertedAt,
      watchId,
      storeId
    );
  }

  storeLines(stores, t) {
    return stores
      .map((s) => `• ${escapeHtml(s.store_name)} — ${t.inStore} ${s.inStore ?? s.in_store ?? 0} · ${t.collect} ${s.clickCollect ?? s.click_collect ?? 0}`)
      .join("\n");
  }

  watchButtons(watch) {
    const t = TEXT[watch.lang] || TEXT.en;
    const rows = [];
    if (watch.product_url) rows.push([{ text: t.open, url: watch.product_url }]);
    rows.push([{ text: t.stop, callback_data: `stop:${watch.id}` }]);
    return rows;
  }

  async send(chatId, text, buttons = null) {
    await sendTelegram(this.env.TELEGRAM_BOT_TOKEN, [chatId], { text, html: true, buttons }, {
      ...this.tgOptions(),
      log: (line) => console.log(line)
    });
  }

  tgOptions() {
    return { fetchImpl: this.fetchImpl, base: this.env.TELEGRAM_API_BASE || undefined };
  }

  // ------------------------------------------------------------ setup

  async setup(origin) {
    if (!this.enabled()) throw httpError(503, "TELEGRAM_BOT_TOKEN is not set");
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const opts = this.tgOptions();

    const me = await telegramApi(token, "getMe", {}, opts);
    if (!me.ok) throw httpError(502, `getMe failed: ${me.description}`);

    const hook = await telegramApi(
      token,
      "setWebhook",
      {
        url: `${origin}/api/telegram/webhook`,
        secret_token: this.env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      },
      opts
    );
    if (!hook.ok) throw httpError(502, `setWebhook failed: ${hook.description}`);

    await telegramApi(
      token,
      "setMyCommands",
      { commands: [{ command: "list", description: "My alerts / 我的提醒" }, { command: "stop", description: "Stop all alerts / 停止全部" }] },
      opts
    );

    this.setMeta("bot_username", me.result.username);
    return { ok: true, botUsername: me.result.username, webhook: `${origin}/api/telegram/webhook` };
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function randomId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

function cleanText(value, max) {
  return String(value).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
