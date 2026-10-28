// Distance helpers for the Officeworks store finder.

import { lookupPostcode } from "./postcodes-au.mjs";

// Great-circle distance in km.
export function haversineKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Where to measure from: explicit coordinates (browser location) win over a
// postcode. Returns { lat, lng, source, postcode, state } or null.
export function resolveOrigin({ lat, lng, postcode } = {}) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat !== null && lat !== undefined && lat !== "" && Number.isFinite(la) && Number.isFinite(ln) &&
      la >= -45 && la <= -9 && ln >= 110 && ln <= 155) {
    return { lat: la, lng: ln, source: "coordinates", postcode: postcode || "", state: "" };
  }
  const found = postcode ? lookupPostcode(postcode) : null;
  if (found) return { lat: found.lat, lng: found.lng, source: "postcode", postcode: found.postcode, state: found.state };
  return null;
}

// Adds distanceKm to each store with coordinates, keeps those within
// radiusKm and sorts nearest first.
export function storesWithinRadius(stores, origin, radiusKm) {
  return stores
    .filter((store) => Number.isFinite(store.lat) && Number.isFinite(store.lng))
    .map((store) => ({ ...store, distanceKm: Math.round(haversineKm(origin, store) * 10) / 10 }))
    .filter((store) => store.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || String(a.storeName).localeCompare(String(b.storeName)));
}
