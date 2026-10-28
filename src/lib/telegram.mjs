// Minimal Telegram Bot API helpers (no dependencies).

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

export const TELEGRAM_API = "https://api.telegram.org";

// Calls a Bot API method; returns the parsed JSON ({ ok, result | description }).
// base: another Bot API server (local testing).
export async function telegramApi(token, method, body, { fetchImpl = fetch, base = TELEGRAM_API } = {}) {
  const res = await fetchImpl(`${base || TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  try {
    return await res.json();
  } catch {
    return { ok: false, description: `HTTP ${res.status}` };
  }
}

// Sends to every chat id; returns the number of failed sends.
// button: one URL button; buttons: rows of inline keyboard buttons.
export async function sendTelegram(
  token,
  chatIds,
  { text, html = false, button = null, buttons = null },
  { fetchImpl = fetch, log = () => {}, base = TELEGRAM_API } = {}
) {
  if (!token || !chatIds || !chatIds.length) return 0;

  const keyboard = buttons || (button ? [[button]] : null);
  let failed = 0;
  for (const chatId of chatIds) {
    const body = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(html ? { parse_mode: "HTML" } : {}),
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
    };
    try {
      const data = await telegramApi(token, "sendMessage", body, { fetchImpl, base });
      if (!data.ok) {
        failed += 1;
        log(`Telegram send failed: ${data.description || "unknown error"}`);
      }
    } catch (err) {
      failed += 1;
      log(`Telegram send failed: ${err.message}`);
    }
  }
  return failed;
}
