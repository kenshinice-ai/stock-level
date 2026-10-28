import assert from "node:assert/strict";
import { test } from "node:test";
import { STORES } from "../src/apple/catalog-au.mjs";
import { AppleWatcher, readWatchConfig } from "../src/apple/watcher.mjs";

function fakeState() {
  const data = new Map();
  let alarm = null;
  return {
    storage: {
      async get(key) { return data.has(key) ? structuredClone(data.get(key)) : undefined; },
      async put(key, value) { data.set(key, structuredClone(value)); },
      async getAlarm() { return alarm; },
      async setAlarm(at) { alarm = at; },
      async deleteAlarm() { alarm = null; }
    }
  };
}

// Apple mock: `available` decides per (store, part); Telegram calls are recorded.
function fakeFetch(available, sent, { blocked = false } = {}) {
  return async (url, init) => {
    url = String(url);
    if (url.includes("api.telegram.org")) {
      sent.push(JSON.parse(init.body).text);
      return new Response("{\"ok\":true}");
    }
    if (blocked()) return new Response("<!doctype html>", { status: 541 });
    const u = new URL(url);
    const anchor = STORES.find((s) => s.postcode === u.searchParams.get("postalCode")).id;
    const parts = [...u.searchParams].filter(([k]) => k.startsWith("parts.")).map(([, v]) => v);
    const nearby = anchor === "R180" ? ["R180", "R343", "R342", "R504", "R530"] : [anchor];
    const stores = nearby.map((id) => ({
      storeNumber: id,
      storePickEligible: true,
      partsAvailability: Object.fromEntries(
        parts.map((p) => [p, { pickupDisplay: available(id, p) ? "available" : "unavailable", storeSearchEnabled: true }])
      )
    }));
    return new Response(JSON.stringify({ body: { content: { pickupMessage: { stores } } } }));
  };
}

const ENV = { WATCH_STORES: "VIC", WATCH_CAPS: "256gb", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" };

test("readWatchConfig defaults to iPhone Duo in VIC every 30s", () => {
  const c = readWatchConfig({});
  assert.equal(c.family, "iphoneduo");
  assert.equal(c.stores.length, 5);
  assert.equal(c.parts.length, 8);
  assert.equal(c.intervalSec, 30);
  assert.equal(readWatchConfig({ WATCH_INTERVAL_SEC: "5" }).intervalSec, 20);
});

test("watcher alerts once per restock and persists state across runs", async () => {
  let inStock = false;
  const sent = [];
  const env = { ...ENV };
  const state = fakeState();

  const run = async (now) => {
    // A new instance per run, like a Durable Object waking from eviction.
    const w = new AppleWatcher(state, env);
    w.fetchImpl = fakeFetch((id, p) => inStock && id === "R343" && p === "MK2E4X/A", sent, { blocked: () => false });
    return w.runOnce(readWatchConfig(env), now);
  };

  assert.equal(await run(0), 30);
  assert.equal(sent.length, 1); // start message
  assert.match(sent[0], /开始监控 iPhone Duo/);

  inStock = true;
  await run(30000);
  await run(60000);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Southland/);
  assert.match(sent[1], /256 GB Night Sky/);

  const status = await state.storage.get("status");
  assert.equal(status.ok, true);
  assert.equal(status.rows.find((r) => r.storeId === "R343").status, "in_stock");

  inStock = false;
  await run(90000);
  await run(120000);
  const recent = (await state.storage.get("watch")).recent;
  assert.deepEqual(recent.map((e) => e.type), ["sold_out", "landed"]);
  assert.equal(sent.length, 2);
});

test("watcher backs off and warns once when Apple blocks it", async () => {
  let blocked = true;
  const sent = [];
  const state = fakeState();
  const delays = [];
  for (let i = 0; i < 6; i++) {
    const w = new AppleWatcher(state, ENV);
    w.fetchImpl = fakeFetch(() => false, sent, { blocked: () => blocked });
    delays.push(await w.runOnce(readWatchConfig(ENV), i * 1000));
  }
  assert.deepEqual(delays, [60, 120, 240, 480, 900, 900]);
  assert.equal(sent.filter((t) => t.includes("拒绝")).length, 1);
  assert.equal((await state.storage.get("status")).blocked, true);

  blocked = false;
  const w = new AppleWatcher(state, ENV);
  w.fetchImpl = fakeFetch(() => false, sent, { blocked: () => blocked });
  assert.equal(await w.runOnce(readWatchConfig(ENV), 10000), 30);
  assert.ok(sent.at(-1).includes("恢复"));
});

test("ensure starts the alarm loop, and alarm always reschedules", async () => {
  const state = fakeState();
  const w = new AppleWatcher(state, ENV);
  w.fetchImpl = fakeFetch(() => false, [], { blocked: () => false });
  await w.fetch(new Request("https://apple-watcher/ensure"));
  assert.ok(await state.storage.getAlarm());

  await state.storage.setAlarm(null);
  w.fetchImpl = async () => { throw new Error("network down"); };
  await w.alarm();
  assert.ok(await state.storage.getAlarm());

  const off = new AppleWatcher(state, { ...ENV, WATCH_ENABLED: "0" });
  await off.fetch(new Request("https://apple-watcher/ensure"));
  assert.equal(await state.storage.getAlarm(), null);
});
