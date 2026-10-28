// Telegram alerts shared by the local agent and the Cloudflare watcher.

import { escapeHtml, sendTelegram } from "../lib/telegram.mjs";
import { STORE_BY_ID, describePart, productUrl } from "./catalog-au.mjs";

export { escapeHtml, sendTelegram };

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

export function csv(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
