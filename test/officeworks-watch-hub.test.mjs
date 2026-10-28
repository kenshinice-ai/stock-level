import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WatchHub } from "../src/officeworks/watch-hub.mjs";

// Minimal stand-in for Durable Object SQLite storage (ctx.storage.sql).
function fakeState() {
  const db = new DatabaseSync(":memory:");
  return {
    storage: {
      sql: {
        exec(query, ...bindings) {
          if (!bindings.length && query.trim().split(";").filter((q) => q.trim()).length > 1) {
            db.exec(query);
            return cursor([], 0);
          }
          const stmt = db.prepare(query);
          if (/^\s*(SELECT|WITH)/i.test(query)) return cursor(stmt.all(...bindings).map((r) => ({ ...r })), 0);
          return cursor([], stmt.run(...bindings).changes);
        }
      }
    }
  };
}

function cursor(rows, rowsWritten) {
  return {
    rowsWritten,
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
      return rows[0];
    }
  };
}

// Officeworks + Telegram mock. stock: Map("STORE|SKU" -> qty).
function fakeNetwork(stock) {
  const sent = [];
  const calls = { availability: 0 };
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body || "{}");
      if (method === "getMe") return Response.json({ ok: true, result: { username: "pwe_stock_bot" } });
      if (method === "sendMessage") sent.push(body);
      return Response.json({ ok: true, result: true });
    }
    const m = url.match(/availabilities\/store\/([^/]+)\/postcode\/\d+\?partNumbers=([A-Z0-9]+)/);
    if (m) {
      calls.availability += 1;
      const qty = stock.get(`${m[1]}|${m[2]}`) ?? 0;
      return Response.json([{ sku: m[2], inStoreQuantity: qty, clickAndCollectQuantity: qty, deliveryQuantity: 0 }]);
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, sent, calls };
}

const ENV = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "s3cret" };
const STORES = [
  { storeId: "W393", storeName: "Chadstone Officeworks", postcode: "3148" },
  { storeId: "W345", storeName: "Carnegie Officeworks", postcode: "3163" }
];

async function call(hub, path, body) {
  const res = await hub.fetch(
    new Request(`https://watch-hub${path}`, body ? { method: "POST", body: JSON.stringify(body) } : {})
  );
  return res.json();
}

function startMessage(chatId, id) {
  return { message: { chat: { id: chatId }, from: { language_code: "zh-hans" }, text: `/start ${id}` } };
}

async function setupHub(stock) {
  const net = fakeNetwork(stock);
  const hub = new WatchHub(fakeState(), ENV);
  hub.fetchImpl = net.fetchImpl;
  let clock = 1_800_000_000_000;
  hub.now = () => clock;
  const advance = (ms) => { clock += ms; };
  assert.equal((await call(hub, "/setup", { origin: "https://stock.example" })).botUsername, "pwe_stock_bot");
  return { hub, net, advance };
}

test("create -> link via /start -> alert only when a store comes into stock", async () => {
  const stock = new Map([["W393|IPDMW128B", 0], ["W345|IPDMW128B", 2]]);
  const { hub, net, advance } = await setupHub(stock);

  const created = await call(hub, "/create", {
    sku: "ipdmw128b", productName: "iPad mini 128GB", productUrl: "https://www.officeworks.com.au/p/x", stores: STORES, lang: "zh"
  });
  assert.equal(created.ok, true);
  assert.equal(created.startUrl, `https://t.me/pwe_stock_bot?start=${created.id}`);
  assert.equal((await call(hub, `/watch?id=${created.id}`)).linked, false);

  await call(hub, "/telegram", startMessage(42, created.id));
  assert.equal((await call(hub, `/watch?id=${created.id}`)).linked, true);
  assert.match(net.sent[0].text, /已开始监控/);
  assert.match(net.sent[1].text, /现在就有货[\s\S]*Carnegie/); // Carnegie already has it
  assert.equal(net.sent.length, 2);

  // Nothing changed: a run checks nothing yet (recently checked) and sends nothing.
  let run = await call(hub, "/run", {});
  assert.equal(run.checked, 0);
  advance(5 * 60 * 1000);
  run = await call(hub, "/run", {});
  assert.equal(run.checked, 2);
  assert.equal(run.alerts, 0);

  // Chadstone restocks -> one alert naming Chadstone only.
  stock.set("W393|IPDMW128B", 3);
  advance(5 * 60 * 1000);
  run = await call(hub, "/run", {});
  assert.equal(run.alerts, 1);
  const alert = net.sent.at(-1);
  assert.equal(alert.chat_id, 42);
  assert.match(alert.text, /到货了[\s\S]*Chadstone/);
  assert.doesNotMatch(alert.text, /Carnegie/);
  assert.deepEqual(alert.reply_markup.inline_keyboard.at(-1)[0].callback_data, `stop:${created.id}`);

  // Still in stock next run -> no repeat alert.
  advance(5 * 60 * 1000);
  assert.equal((await call(hub, "/run", {})).alerts, 0);

  // Goes out, comes back -> alerts again.
  stock.set("W393|IPDMW128B", 0);
  advance(5 * 60 * 1000);
  await call(hub, "/run", {});
  stock.set("W393|IPDMW128B", 1);
  advance(5 * 60 * 1000);
  assert.equal((await call(hub, "/run", {})).alerts, 1);
});

test("stop button deactivates the watch; /list shows what is left", async () => {
  const { hub, net, advance } = await setupHub(new Map());
  const a = await call(hub, "/create", { sku: "JBAALR618B", productName: "AA 18", stores: STORES });
  const b = await call(hub, "/create", { sku: "COALKVBE", productName: "Cable", stores: STORES.slice(0, 1) });
  await call(hub, "/telegram", startMessage(7, a.id));
  await call(hub, "/telegram", startMessage(7, b.id));

  await call(hub, "/telegram", {
    callback_query: { id: "cb1", from: { language_code: "en" }, message: { chat: { id: 7 } }, data: `stop:${a.id}` }
  });
  assert.equal((await call(hub, `/watch?id=${a.id}`)).active, false);
  assert.equal(net.sent.at(-1).text, "Alert stopped.");

  await call(hub, "/telegram", { message: { chat: { id: 7 }, from: { language_code: "en" }, text: "/list" } });
  const list = net.sent.at(-1).reply_markup.inline_keyboard;
  assert.equal(list.length, 2); // Cable + "stop all"
  assert.equal(list[0][0].callback_data, `stop:${b.id}`);

  // Stopped watches are not checked any more.
  net.calls.availability = 0;
  advance(10 * 60 * 1000);
  await call(hub, "/run", {});
  assert.equal(net.calls.availability, 1); // only Cable at Chadstone
});

test("links cannot be reused by another chat and expire if never used", async () => {
  const { hub, net, advance } = await setupHub(new Map());
  const w = await call(hub, "/create", { sku: "JBAALR618B", productName: "AA", stores: STORES });
  await call(hub, "/telegram", startMessage(1, w.id));
  await call(hub, "/telegram", startMessage(2, w.id));
  assert.match(net.sent.at(-1).text, /已过期/);
  assert.equal(net.sent.at(-1).chat_id, 2);

  const pending = await call(hub, "/create", { sku: "JBAALR618B", productName: "AA", stores: STORES });
  advance(25 * 60 * 60 * 1000);
  await call(hub, "/run", {});
  await call(hub, "/telegram", startMessage(3, pending.id));
  assert.match(net.sent.at(-1).text, /已过期/);
});

test("linked watches expire after 30 days with a notice", async () => {
  const { hub, net, advance } = await setupHub(new Map());
  const w = await call(hub, "/create", { sku: "JBAALR618B", productName: "AA Batteries", stores: STORES, lang: "en" });
  await call(hub, "/telegram", { message: { chat: { id: 9 }, from: { language_code: "en" }, text: `/start ${w.id}` } });
  advance(31 * 24 * 60 * 60 * 1000);
  const run = await call(hub, "/run", {});
  assert.equal(run.expired, 1);
  assert.match(net.sent.at(-1).text, /expired/);
  assert.equal((await call(hub, `/watch?id=${w.id}`)).active, false);
});

test("create validates input", async () => {
  const { hub } = await setupHub(new Map());
  assert.equal((await call(hub, "/create", { sku: "!", stores: STORES })).ok, false);
  assert.equal((await call(hub, "/create", { sku: "JBAALR618B", stores: [{ storeId: "x", postcode: "1" }] })).ok, false);
  const many = Array.from({ length: 15 }, (_, i) => ({ storeId: `W${300 + i}`, storeName: `S${i}`, postcode: "3000" }));
  assert.equal((await call(hub, "/create", { sku: "JBAALR618B", stores: many })).stores, 10);
});
