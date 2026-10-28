// Apple Store Australia: stores and iPhone part numbers.
// Seed data captured 2026-10-28. Part numbers are AU ("X/A" suffix).

export const COUNTRY = "au";
export const APPLE_BASE = "https://www.apple.com/au";

// [storeId, name, city, lat, lng, timezone, state]
const STORE_ROWS = [
  ["R254", "Bondi", "Bondi Junction", -33.89228, 151.2503, "Australia/Sydney", "NSW"],
  ["R508", "Booragoon", "Booragoon", -32.03422, 115.83735, "Australia/Perth", "WA"],
  ["R466", "Brisbane", "Brisbane City", -27.46835, 153.027261, "Australia/Brisbane", "QLD"],
  ["R523", "Broadway", "Broadway", -33.88367, 151.19421, "Australia/Sydney", "NSW"],
  ["R483", "Canberra", "Canberra", -35.28026, 149.13371, "Australia/Sydney", "ACT"],
  ["R509", "Carindale", "Carindale", -27.50227, 153.10189, "Australia/Brisbane", "QLD"],
  ["R344", "Castle Towers", "Castle Hill", -33.730556, 151.006111, "Australia/Sydney", "NSW"],
  ["R180", "Chadstone", "Chadstone", -37.885829, 145.082502, "Australia/Melbourne", "VIC"],
  ["R385", "Charlestown", "Charlestown", -32.96363, 151.69406, "Australia/Sydney", "NSW"],
  ["R253", "Chatswood Chase", "Chatswood", -33.79499, 151.18613, "Australia/Sydney", "NSW"],
  ["R384", "Chermside", "Chermside", -27.3856, 153.0302, "Australia/Brisbane", "QLD"],
  ["R342", "Doncaster", "Doncaster", -37.78442, 145.1261, "Australia/Melbourne", "VIC"],
  ["R530", "Fountain Gate", "Fountain Gate", -38.01799, 145.30466, "Australia/Melbourne", "VIC"],
  ["R504", "Highpoint", "Maribyrnong", -37.77238, 144.89015, "Australia/Melbourne", "VIC"],
  ["R606", "Miranda", "Miranda", -34.03492, 151.10088, "Australia/Sydney", "NSW"],
  ["R440", "Penrith", "Penrith", -33.751287, 150.694699, "Australia/Sydney", "NSW"],
  ["R386", "Perth City", "Perth", -31.952658, 115.858728, "Australia/Perth", "WA"],
  ["R351", "Robina", "Robina", -28.077575, 153.385213, "Australia/Brisbane", "QLD"],
  ["R405", "Rundle Place", "Adelaide", -34.922821, 138.602631, "Australia/Adelaide", "SA"],
  ["R343", "Southland", "Cheltenham", -37.958244, 145.052434, "Australia/Melbourne", "VIC"],
  ["R238", "Sydney", "Sydney", -33.86889, 151.20678, "Australia/Sydney", "NSW"]
];

export const STORES = STORE_ROWS.map(([id, name, city, lat, lng, tz, state]) => ({
  id,
  name,
  city,
  lat,
  lng,
  tz,
  state
}));

export const STORE_BY_ID = Object.fromEntries(STORES.map((s) => [s.id, s]));

// One store per metro area. With searchNearby=true Apple returns the anchor
// plus nearby stores, so these few requests cover the country. Any store that
// is not returned is queried directly on the next round.
export const DEFAULT_ANCHORS = ["R238", "R180", "R466", "R405", "R386", "R483"];

const PRO_COLORS = [
  ["black", "Black"],
  ["burgundy", "Burgundy"],
  ["glacier", "Glacier"],
  ["silver", "Silver"]
];

const CAPS = [
  ["256gb", "256 GB"],
  ["512gb", "512 GB"],
  ["1tb", "1 TB"],
  ["2tb", "2 TB"]
];

export const FAMILIES = {
  iphoneduo: {
    family: "iphoneduo",
    name: "iPhone Duo",
    colors: [
      ["nightsky", "Night Sky"],
      ["starwhite", "Star White"]
    ],
    caps: CAPS,
    // part: [cap, color, priceAud]
    parts: {
      "MK2E4X/A": ["256gb", "nightsky", 3499],
      "MK2D4X/A": ["256gb", "starwhite", 3499],
      "MK2G4X/A": ["512gb", "nightsky", 3899],
      "MK2F4X/A": ["512gb", "starwhite", 3899],
      "MK2J4X/A": ["1tb", "nightsky", 4699],
      "MK2H4X/A": ["1tb", "starwhite", 4699],
      "MK2L4X/A": ["2tb", "nightsky", 5899],
      "MK2K4X/A": ["2tb", "starwhite", 5899]
    }
  },
  iphone18promax: {
    family: "iphone18promax",
    name: "iPhone 18 Pro Max",
    colors: PRO_COLORS,
    caps: CAPS,
    parts: {
      "MJXN4X/A": ["256gb", "black", 2299],
      "MJXQ4X/A": ["256gb", "burgundy", 2299],
      "MJXR4X/A": ["256gb", "glacier", 2299],
      "MJXP4X/A": ["256gb", "silver", 2299],
      "MJXT4X/A": ["512gb", "black", 2699],
      "MJXV4X/A": ["512gb", "burgundy", 2699],
      "MJXW4X/A": ["512gb", "glacier", 2699],
      "MJXU4X/A": ["512gb", "silver", 2699],
      "MJXX4X/A": ["1tb", "black", 3499],
      "MJY04X/A": ["1tb", "burgundy", 3499],
      "MJY14X/A": ["1tb", "glacier", 3499],
      "MJXY4X/A": ["1tb", "silver", 3499],
      "MJY24X/A": ["2tb", "black", 4699],
      "MJY44X/A": ["2tb", "burgundy", 4699],
      "MJY54X/A": ["2tb", "glacier", 4699],
      "MJY34X/A": ["2tb", "silver", 4699]
    }
  },
  iphone18pro: {
    family: "iphone18pro",
    name: "iPhone 18 Pro",
    colors: PRO_COLORS,
    caps: CAPS,
    parts: {
      "MJRP4X/A": ["256gb", "black", 2099],
      "MJRR4X/A": ["256gb", "burgundy", 2099],
      "MJRT4X/A": ["256gb", "glacier", 2099],
      "MJRQ4X/A": ["256gb", "silver", 2099],
      "MJRU4X/A": ["512gb", "black", 2499],
      "MJRW4X/A": ["512gb", "burgundy", 2499],
      "MJRX4X/A": ["512gb", "glacier", 2499],
      "MJRV4X/A": ["512gb", "silver", 2499],
      "MJRY4X/A": ["1tb", "black", 3299],
      "MJT14X/A": ["1tb", "burgundy", 3299],
      "MJT24X/A": ["1tb", "glacier", 3299],
      "MJT04X/A": ["1tb", "silver", 3299],
      "MJT34X/A": ["2tb", "black", 4499],
      "MJT54X/A": ["2tb", "burgundy", 4499],
      "MJT64X/A": ["2tb", "glacier", 4499],
      "MJT44X/A": ["2tb", "silver", 4499]
    }
  }
};

export function describePart(part) {
  for (const fam of Object.values(FAMILIES)) {
    const info = fam.parts[part];
    if (!info) continue;
    const [cap, color, price] = info;
    const capLabel = (fam.caps.find(([k]) => k === cap) || [cap, cap])[1];
    const colorLabel = (fam.colors.find(([k]) => k === color) || [color, color])[1];
    return {
      part,
      family: fam.family,
      familyName: fam.name,
      cap,
      color,
      price,
      label: `${fam.name} ${capLabel} ${colorLabel}`
    };
  }
  return { part, family: "", familyName: "", cap: "", color: "", price: null, label: part };
}

// Filter a family's parts by capacity / colour keys (empty = any).
export function selectParts(family, { caps = [], colors = [] } = {}) {
  const fam = FAMILIES[family];
  if (!fam) return [];
  return Object.entries(fam.parts)
    .filter(([, [cap, color]]) => (!caps.length || caps.includes(cap)) && (!colors.length || colors.includes(color)))
    .map(([part]) => part);
}

export function productUrl(part) {
  return `${APPLE_BASE}/shop/product/${part}`;
}

// Anchors for a set of target stores: one per state, preferring the default
// metro anchor when it is itself a target.
export function pickAnchors(targetStoreIds) {
  const byState = new Map();
  for (const id of targetStoreIds) {
    const store = STORE_BY_ID[id];
    if (!store) continue;
    const current = byState.get(store.state);
    if (!current || (DEFAULT_ANCHORS.includes(id) && !DEFAULT_ANCHORS.includes(current))) {
      byState.set(store.state, id);
    }
  }
  return [...byState.values()];
}

// "all", store ids (R180), states (VIC), store names or cities, comma separated.
export function resolveStores(value) {
  const tokens = String(value || "all")
    .split(",")
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean);
  if (!tokens.length || tokens.includes("ALL")) return STORES.map((s) => s.id);
  return STORES.filter((store) =>
    tokens.some(
      (token) =>
        store.id === token ||
        store.state === token ||
        store.name.toUpperCase() === token ||
        store.city.toUpperCase() === token
    )
  ).map((store) => store.id);
}
