import assert from "node:assert/strict";
import { test } from "node:test";
import { createRestockTracker } from "../src/apple/restock-state.mjs";

const PART = "MK2E4X/A";

function round(status, { searchEnabled = true, pickupEligible = true } = {}) {
  const parts = status ? { [PART]: { status, searchEnabled, quote: "" } } : {};
  return new Map([["R180", { storeId: "R180", pickupEligible, parts }]]);
}

test("alerts on first sighting and sells out after two misses", () => {
  const t = createRestockTracker({ outRounds: 2, realertMs: 90000 });
  assert.equal(t.update(round("unavailable"), ["R180"], [PART], 0).landed.length, 0);
  assert.equal(t.update(round("available"), ["R180"], [PART], 1000).landed.length, 1);
  assert.equal(t.update(round("available"), ["R180"], [PART], 2000).landed.length, 0);
  assert.equal(t.update(round("unavailable"), ["R180"], [PART], 3000).soldOut.length, 0);
  assert.equal(t.inStock().length, 1);
  const out = t.update(round("unavailable"), ["R180"], [PART], 4000).soldOut;
  assert.equal(out.length, 1);
  assert.equal(out[0].durationMs, 3000);
  assert.equal(t.inStock().length, 0);
});

test("one flaky miss does not re-alert", () => {
  const t = createRestockTracker({ outRounds: 2 });
  t.update(round("available"), ["R180"], [PART], 0);
  t.update(round("unavailable"), ["R180"], [PART], 1000);
  assert.equal(t.update(round("available"), ["R180"], [PART], 2000).landed.length, 0);
});

test("comeback within the re-alert window continues the same restock", () => {
  const t = createRestockTracker({ outRounds: 1, realertMs: 90000 });
  t.update(round("available"), ["R180"], [PART], 0);
  t.update(round("unavailable"), ["R180"], [PART], 30000);
  assert.equal(t.update(round("available"), ["R180"], [PART], 60000).landed.length, 0);
  t.update(round("unavailable"), ["R180"], [PART], 70000);
  assert.equal(t.update(round("available"), ["R180"], [PART], 200000).landed.length, 1);
});

test("untrusted results keep the previous state", () => {
  const t = createRestockTracker({ outRounds: 1 });
  t.update(round("available"), ["R180"], [PART], 0);
  t.update(round("unavailable", { searchEnabled: false }), ["R180"], [PART], 1000);
  t.update(round("unknown"), ["R180"], [PART], 2000);
  t.update(new Map(), ["R180"], [PART], 3000);
  assert.equal(t.inStock().length, 1);
});

test("available at a store without pickup does not alert", () => {
  const t = createRestockTracker();
  assert.equal(t.update(round("available", { pickupEligible: false }), ["R180"], [PART], 0).landed.length, 0);
});
