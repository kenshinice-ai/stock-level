// Telegram alerts shared by the local agent and the Cloudflare watcher.

import { STORE_BY_ID, describePart, productUrl } from "./catalog-au.mjs";

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Groups landed items by store: [{ storeId, store, items }]
export function groupByStore(landed) {
  const byStore = new Map();
  for (const item of landed) {
    if (!byStore.has(item.storeId)) byStore.set(item.storeId, []);
    byStore.get(item.storeId).push(item);
  }
  return [...byStore].map(([storeId, items]) => ({ storeId, store: STORE_BY_ID[storeId] || null, items }));
}

// Telegram message (HTML) for new stock at one store.
export function landedMessage({ storeId, store, items }, { source = "" } = {}) {
  const lines = items.map((item) => {
    const d = describePart(item.part);
    const quote = item.quote ? ` — ${escapeHtml(item.quote)}` : "";
    return `• <a href="${productUrl(item.part)}">${escapeHtml(d.label)}</a>${quote}`;
  });
  const first = describePart(items[0].part);

  return {
    text:
      `🟢 <b>有货！Apple ${escapeHtml(store ? store.name : storeId)}</b>` +
      (store ? ` (${escapeHtml(store.city)}, ${store.state})` : "") +
      `\n${lines.join("\n")}\n\n点链接 → 选 Pickup → 选这家店，尽快付款锁定。` +
      (source ? `\n<i>${escapeHtml(source)}</i>` : ""),
    html: true,
    button: { text: `Reserve ${first.label}`, url: productUrl(items[0].part) }
  };
}

// Sends to every chat id; returns the number of failed sends.
export async function sendTelegram(token, chatIds, { text, html = false, button = null }, { fetchImpl = fetch, log = () => {} } = {}) {
  if (!token || !chatIds || !chatIds.length) return 0;

  let failed = 0;
  for (const chatId of chatIds) {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(html ? { parse_mode: "HTML" } : {}),
      ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {})
    };
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        failed += 1;
        log(`Telegram send failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      failed += 1;
      log(`Telegram send failed: ${err.message}`);
    }
  }
  return failed;
}

export function csv(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
