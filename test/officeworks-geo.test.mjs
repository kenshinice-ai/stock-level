import assert from "node:assert/strict";
import { test } from "node:test";
import { haversineKm, resolveOrigin, storesWithinRadius } from "../src/officeworks/geo.mjs";
import { lookupPostcode } from "../src/officeworks/postcodes-au.mjs";

test("lookupPostcode returns the postcode centre and state", () => {
  const pc = lookupPostcode("3148");
  assert.equal(pc.state, "VIC");
  assert.ok(Math.abs(pc.lat + 37.89) < 0.05 && Math.abs(pc.lng - 145.1) < 0.05);
  assert.equal(lookupPostcode("800").state, "NT"); // leading zero
  assert.equal(lookupPostcode("9999"), null);
});

test("haversineKm: Melbourne to Sydney is about 714 km", () => {
  const km = haversineKm({ lat: -37.8136, lng: 144.9631 }, { lat: -33.8688, lng: 151.2093 });
  assert.ok(km > 700 && km < 725, String(km));
});

test("resolveOrigin prefers valid coordinates, falls back to postcode", () => {
  assert.equal(resolveOrigin({ lat: "-37.88", lng: "145.08", postcode: "2000" }).source, "coordinates");
  assert.equal(resolveOrigin({ lat: "51.5", lng: "-0.1", postcode: "2000" }).source, "postcode"); // not in Australia
  assert.equal(resolveOrigin({ postcode: "2000" }).state, "NSW");
  assert.equal(resolveOrigin({ postcode: "9999" }), null);
  assert.equal(resolveOrigin({}), null);
});

test("storesWithinRadius filters, adds distance and sorts nearest first", () => {
  const stores = [
    { storeName: "Far", lat: -33.87, lng: 151.21 },
    { storeName: "Near", lat: -37.886, lng: 145.083 },
    { storeName: "No coords", lat: null, lng: null },
    { storeName: "Mid", lat: -37.81, lng: 144.96 }
  ];
  const result = storesWithinRadius(stores, lookupPostcode("3148"), 25);
  assert.deepEqual(result.map((s) => s.storeName), ["Near", "Mid"]);
  assert.ok(result[0].distanceKm < 2);
});
