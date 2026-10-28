#!/usr/bin/env node
// Local iPhone pickup-stock watcher for Apple Stores in Australia.
// Polls Apple's pickup availability from your own computer and sends a
// Telegram message (plus a sound on macOS) the moment a model lands.
//
//   node --env-file=agent/.env agent/apple-agent.mjs            watch
//   node --env-file=agent/.env agent/apple-agent.mjs --once     one check, print table
//   node --env-file=agent/.env agent/apple-agent.mjs --telegram-setup
//   node --env-file=agent/.env agent/apple-agent.mjs --test-alert
//
// See agent/README.md for configuration.

import { spawn } from "node:child_process";
import {
  APPLE_BASE,
  FAMILIES,
  STORE_BY_ID,
  describePart,
  pickAnchors,
  productUrl,
  resolveStores,
  selectParts
} from "../src/apple/catalog-au.mjs";
import { scanStores } from "../src/apple/fulfillment.mjs";
import { csv, escapeHtml, groupByStore, landedMessage, sendTelegram } from "../src/apple/notify.mjs";
import { createRestockTracker } from "../src/apple/restock-state.mjs";

const args = new Set(process.argv.slice(2));
const env = process.env;

const config = {
  family: (env.FAMILY || "iphoneduo").trim().toLowerCase(),
  stores: resolveStores(env.STORES || "all"),
  caps: csv(env.CAPS).map((v) => v.toLowerCase().replace(/\s+/g, "")),
  colors: csv(env.COLORS).map((v) => v.toLowerCase().replace(/\s+/g, "")),
  intervalSec: Math.max(15, Number(env.INTERVAL_SEC) || 30),
  telegramToken: (env.TELEGRAM_BOT_TOKEN || "").trim(),
  telegramChatIds: csv(env.TELEGRAM_CHAT_ID),
  say: env.SAY !== "0",
  // Consecutive "unavailable" rounds before a part counts as sold out again.
  outRounds: Math.max(1, Number(env.OUT_ROUNDS) || 2),
  // A part that comes back within this window is treated as the same restock.
  realertSec: Math.max(0, Number(env.REALERT_SEC) || 90)
};

const MAX_BACKOFF_SEC = 15 * 60;

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

async function main() {
  if (args.has("--telegram-setup")) return telegramSetup();
  if (args.has("--test-alert")) return testAlert();

  const fam = FAMILIES[config.family];
  if (!fam) {
    throw new Error(`Unknown FAMILY "${config.family}". Use one of: ${Object.keys(FAMILIES).join(", ")}`);
  }

  const parts = selectParts(config.family, { caps: config.caps, colors: config.colors });
  if (!parts.length) throw new Error("CAPS / COLORS filter matches no part numbers.");
  if (!config.stores.length) throw new Error("STORES matches no Apple Store.");

  const anchors = pickAnchors(config.stores);

  log(
    `Watching ${fam.name} (${parts.length} configs: ${parts.map((p) => shortLabel(p)).join(", ")})` +
      ` at ${config.stores.length} store(s), every ~${config.intervalSec}s.`
  );
  log(`Anchors: ${anchors.map(storeName).join(", ")}`);
  if (!config.telegramToken || !config.telegramChatIds.length) {
    log("Telegram not configured: alerts will only show here" + (config.say ? " and play a sound." : "."));
  }

  if (args.has("--once")) {
    const result = await scan(parts, anchors);
    printTable(result, parts);
    return;
  }

  await notify(
    `👀 开始监控 ${fam.name}\n` +
      `${config.stores.length} 家门店 · ${parts.length} 个配置 · 每 ~${config.intervalSec} 秒检查一次`
  );

  const tracker = createRestockTracker({ outRounds: config.outRounds, realertMs: config.realertSec * 1000 });
  let blockedRounds = 0;
  let warnedBlocked = false;

  for (;;) {
    let result;
    try {
      result = await scan(parts, anchors);
    } catch (err) {
      result = { stores: new Map(), requests: 0, errors: [{ message: err.message }], blocked: false };
    }

    if (result.blocked && result.stores.size === 0) {
      blockedRounds += 1;
      const wait = Math.min(MAX_BACKOFF_SEC, config.intervalSec * 2 ** blockedRounds);
      log(`Apple blocked/limited the request (${result.errors[0] && result.errors[0].message}). Backing off ${wait}s.`);
      if (blockedRounds >= 4 && !warnedBlocked) {
        warnedBlocked = true;
        await notify("⚠️ Apple 暂时拒绝了库存查询请求，正在降频重试。如果持续出现，请换一个网络（例如家里宽带而不是 VPN）。");
      }
      await sleep(wait * 1000);
      continue;
    }

    if (warnedBlocked) {
      warnedBlocked = false;
      await notify("✅ 库存查询已恢复正常。");
    }
    blockedRounds = 0;

    const { landed, soldOut } = tracker.update(result.stores, config.stores, parts);
    for (const item of soldOut) {
      const mins = Math.max(1, Math.round(item.durationMs / 60000));
      log(`Sold out: ${shortLabel(item.part)} at ${storeName(item.storeId)} (in stock ~${mins} min)`);
    }
    printRound(result, tracker);

    if (landed.length) await alertLanded(landed);

    await sleep(jitter(config.intervalSec) * 1000);
  }
}

async function scan(parts, anchors) {
  return scanStores(APPLE_BASE, parts, {
    anchors,
    targetStores: config.stores,
    fetchOptions: {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
      }
    }
  });
}

async function alertLanded(landed) {
  for (const group of groupByStore(landed)) {
    log(`IN STOCK at ${storeName(group.storeId)}: ${group.items.map((i) => shortLabel(i.part)).join(", ")}`);
    const message = landedMessage(group);
    await notify(message.text, message);
    beep(`iPhone in stock at ${group.store ? group.store.name : group.storeId}`);
  }
}

// ---------------------------------------------------------------- output

function printRound(result, tracker) {
  const inStock = tracker.inStock().map((row) => `${storeName(row.storeId)}: ${shortLabel(row.part)}`);
  const missing = config.stores.filter((id) => !result.stores.has(id));
  log(
    `checked ${config.stores.length - missing.length}/${config.stores.length} stores in ${result.requests} req` +
      (result.errors.length ? `, ${result.errors.length} error(s)` : "") +
      ` | in stock: ${inStock.length ? inStock.join("; ") : "none"}`
  );
  for (const err of result.errors) log(`  ! ${err.message}`);
}

function printTable(result, parts) {
  const rows = config.stores.map((id) => {
    const store = result.stores.get(id);
    if (!store) return [storeName(id), "not returned"];
    if (!store.pickupEligible) return [storeName(id), "no pickup"];
    const avail = parts.filter((p) => store.parts[p] && store.parts[p].status === "available");
    return [storeName(id), avail.length ? `IN STOCK: ${avail.map(shortLabel).join(", ")}` : "sold out"];
  });
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [name, status] of rows) console.log(`${name.padEnd(width)}  ${status}`);
  console.log(`\n${result.requests} request(s).`);
  for (const err of result.errors) console.log(`! ${err.message}`);
}

// ---------------------------------------------------------------- alerts

async function notify(text, { html = false, button = null } = {}) {
  await sendTelegram(config.telegramToken, config.telegramChatIds, { text, html, button }, { log });
}

function beep(message) {
  process.stdout.write("\x07");
  if (!config.say || process.platform !== "darwin") return;
  try {
    spawn("say", [message], { stdio: "ignore", detached: true }).unref();
  } catch {
    // no sound available
  }
}

async function telegramSetup() {
  if (!config.telegramToken) {
    console.log("Set TELEGRAM_BOT_TOKEN first (create a bot with @BotFather).");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getUpdates`);
  const data = await res.json();
  if (!data.ok) {
    console.log("Telegram error:", data.description || res.status);
    return;
  }
  const chats = new Map();
  for (const update of data.result || []) {
    const msg = update.message || update.channel_post || update.my_chat_member;
    const chat = msg && msg.chat;
    if (chat) chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username);
  }
  if (!chats.size) {
    console.log("No messages yet. Open your bot in Telegram, send it any message (e.g. /start), then run this again.");
    return;
  }
  for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    # ${name}`);
}

async function testAlert() {
  if (!config.telegramToken || !config.telegramChatIds.length) {
    console.log("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID first.");
    return;
  }
  const part = selectParts(config.family)[0] || "MK2E4X/A";
  await notify(`🧪 测试提醒：${escapeHtml(describePart(part).label)} 的到货提醒会长这样。`, {
    html: true,
    button: { text: "Open on Apple", url: productUrl(part) }
  });
  beep("Test alert");
  console.log("Test alert sent.");
}

// ---------------------------------------------------------------- helpers

function storeName(id) {
  return STORE_BY_ID[id] ? STORE_BY_ID[id].name : id;
}

function shortLabel(part) {
  const d = describePart(part);
  return d.family ? d.label.replace(`${d.familyName} `, "") : part;
}

function jitter(sec) {
  return sec * (0.8 + Math.random() * 0.4);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const time = new Date().toLocaleTimeString("en-AU", { hour12: false });
  console.log(`[${time}] ${message}`);
}
