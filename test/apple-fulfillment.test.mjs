import assert from "node:assert/strict";
import { test } from "node:test";
import { APPLE_BASE, STORES, pickAnchors, selectParts } from "../src/apple/catalog-au.mjs";
import {
  UpstreamBlockedError,
  buildFulfillmentUrl,
  fetchFulfillment,
  parseFulfillment,
  scanStores
} from "../src/apple/fulfillment.mjs";

// Shape of body.content.pickupMessage as used by the open-source checkers
// (worthbak/apple-store-inventory-checker, insanoid/Apple-Store-Reserve-Monitor).
function storeEntry(storeNumber, availability, extra = {}) {
  const partsAvailability = {};
  for (const [part, display] of Object.entries(availability)) {
    partsAvailability[part] = {
      pickupDisplay: display,
      storeSearchEnabled: true,
      storePickEligible: true,
      pickupSearchQuote: display === "available" ? "Available Today" : "Currently unavailable",
      messageTypes: { regular: { storePickupQuote: display === "available" ? "<span>Today</span> at Store" : "" } }
    };
  }
  return { storeNumber, storeName: storeNumber, city: "City", storePickEligible: true, partsAvailability, ...extra };
}

function response(stores) {
  return { head: { status: "200" }, body: { content: { pickupMessage: { stores } } } };
}

test("buildFulfillmentUrl encodes parts and anchor store", () => {
  const url = new URL(buildFulfillmentUrl(APPLE_BASE, "R238", ["MK2E4X/A", "MK2D4X/A"]));
  assert.equal(url.pathname, "/au/shop/fulfillment-messages");
  assert.equal(url.searchParams.get("parts.0"), "MK2E4X/A");
  assert.equal(url.searchParams.get("parts.1"), "MK2D4X/A");
  assert.equal(url.searchParams.get("store"), "R238");
  assert.equal(url.searchParams.get("searchNearby"), "true");
});

test("parseFulfillment normalises availability per store and part", () => {
  const raw = response([
    storeEntry("R180", { "MK2E4X/A": "available", "MK2D4X/A": "unavailable" }),
    storeEntry("R384", { "MK2E4X/A": "ineligible" }, { storePickEligible: false })
  ]);
  const { stores } = parseFulfillment(raw, ["MK2E4X/A", "MK2D4X/A"]);
  assert.equal(stores.length, 2);
  assert.deepEqual(stores[0].parts["MK2E4X/A"], {
    status: "available",
    searchEnabled: true,
    quote: "Today at Store"
  });
  assert.equal(stores[0].parts["MK2D4X/A"].status, "unavailable");
  assert.equal(stores[1].pickupEligible, false);
  assert.equal(stores[1].parts["MK2D4X/A"].status, "unknown");
});

test("parseFulfillment tolerates empty or unexpected payloads", () => {
  assert.deepEqual(parseFulfillment(null).stores, []);
  assert.deepEqual(parseFulfillment({ body: {} }).stores, []);
});

test("fetchFulfillment treats 541 and HTML responses as blocked", async () => {
  const html = async () => new Response("<!doctype html><title>Page Not Found</title>", { status: 541 });
  await assert.rejects(fetchFulfillment(APPLE_BASE, "R238", ["MK2E4X/A"], { fetchImpl: html }), UpstreamBlockedError);

  const html200 = async () => new Response("<html></html>", { status: 200 });
  await assert.rejects(fetchFulfillment(APPLE_BASE, "R238", ["MK2E4X/A"], { fetchImpl: html200 }), UpstreamBlockedError);
});

test("scanStores queries anchors, then any target store not covered", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const anchor = new URL(url).searchParams.get("store");
    calls.push(anchor);
    const nearby = anchor === "R180" ? ["R180", "R343", "R342"] : [anchor];
    return new Response(JSON.stringify(response(nearby.map((id) => storeEntry(id, { "MK2E4X/A": "unavailable" })))));
  };
  const result = await scanStores(APPLE_BASE, ["MK2E4X/A"], {
    anchors: ["R180"],
    targetStores: ["R180", "R343", "R342", "R530"],
    fetchOptions: { fetchImpl }
  });
  assert.deepEqual(calls, ["R180", "R530"]);
  assert.equal(result.requests, 2);
  assert.deepEqual([...result.stores.keys()].sort(), ["R180", "R342", "R343", "R530"]);
});

test("pickAnchors picks one store per state, preferring the metro anchor", () => {
  assert.deepEqual(pickAnchors(["R343", "R180", "R504"]), ["R180"]);
  assert.deepEqual(pickAnchors(["R343"]), ["R343"]);
  assert.equal(pickAnchors(STORES.map((s) => s.id)).length, 6);
});

test("selectParts filters by capacity and colour", () => {
  assert.equal(selectParts("iphoneduo").length, 8);
  assert.deepEqual(selectParts("iphoneduo", { caps: ["256gb"], colors: ["nightsky"] }), ["MK2E4X/A"]);
});
