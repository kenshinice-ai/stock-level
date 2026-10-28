// Apple Store pickup availability via the public "fulfillment-messages"
// endpoint (the one behind "Check availability" on apple.com product pages).
// Shared by the Cloudflare Worker and the local agent (agent/apple-agent.mjs).

import { STORE_BY_ID } from "./catalog-au.mjs";

export const FULFILLMENT_PATH = "/shop/fulfillment-messages";

export class UpstreamBlockedError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "UpstreamBlockedError";
    this.status = status;
  }
}

// Same query shape as apple.com's own "iPhone Availability" dialog
// (captured 2026-10-28): the search is by the anchor store's postcode and
// Apple returns the stores near it.
export function buildFulfillmentUrl(appleBase, anchorStore, parts) {
  const store = STORE_BY_ID[anchorStore];
  const qs = new URLSearchParams();
  qs.set("fae", "true");
  if (store) {
    qs.set("postalCode", store.postcode);
    qs.set("state", store.state);
    qs.set("city", store.city);
  } else {
    qs.set("store", anchorStore);
  }
  parts.forEach((part, i) => qs.set(`parts.${i}`, part));
  qs.set("mts.0", "expanded");
  // Part numbers keep their "/" unescaped, as apple.com sends them.
  return `${appleBase}${FULFILLMENT_PATH}?${qs.toString().replace(/%2F/g, "/")}`;
}

// Normalises one fulfillment-messages response.
// Returns { stores: [{ storeId, storeName, city, state, pickupEligible,
//   parts: { [part]: { status, searchEnabled, quote } } }] }
// status: "available" | "unavailable" | "ineligible" | "unknown"
export function parseFulfillment(raw, requestedParts = []) {
  const pickup = raw && raw.body && raw.body.content && raw.body.content.pickupMessage;
  const sourceStores = pickup && Array.isArray(pickup.stores) ? pickup.stores : [];

  const stores = sourceStores
    .filter((store) => store && store.storeNumber)
    .map((store) => {
      const availability = store.partsAvailability || {};
      const parts = {};
      const keys = requestedParts.length ? requestedParts : Object.keys(availability);

      for (const part of keys) {
        const item = availability[part];

        if (!item) {
          parts[part] = { status: "unknown", searchEnabled: false, quote: "" };
          continue;
        }

        const display = String(item.pickupDisplay || "").toLowerCase();
        // The site asks for mts.0=expanded; older clients used regular/compact.
        const types = item.messageTypes || {};
        const message = types.expanded || types.regular || types.compact || Object.values(types)[0] || {};
        const searchEnabled = item.storeSearchEnabled ?? message.storeSearchEnabled;
        let status =
          display === "available" || display === "unavailable" || display === "ineligible" ? display : "unknown";
        if (status !== "available" && item.storePickEligible === false) status = "ineligible";

        parts[part] = {
          status,
          searchEnabled: searchEnabled !== false,
          quote: String(message.storePickupQuote || item.pickupSearchQuote || "").replace(/<[^>]+>/g, "")
        };
      }

      return {
        storeId: String(store.storeNumber).toUpperCase(),
        storeName: String(store.storeName || ""),
        city: String(store.city || (store.address && store.address.city) || ""),
        state: String(store.state || (store.address && store.address.state) || ""),
        pickupEligible: store.storePickEligible !== false,
        parts
      };
    });

  return {
    stores,
    errorMessage: pickup && pickup.errorMessage ? String(pickup.errorMessage) : ""
  };
}

export async function fetchFulfillment(appleBase, anchorStore, parts, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = buildFulfillmentUrl(appleBase, anchorStore, parts);
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs || 10000) : null;

  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-AU,en;q=0.9",
        Referer: `${appleBase}/shop/buy-iphone`,
        ...(options.headers || {})
      },
      signal: controller ? controller.signal : undefined,
      ...(options.fetchInit || {})
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  const looksJson = /^\s*[{[]/.test(text);

  if ([403, 429, 503, 541].includes(response.status) || (!looksJson && response.ok)) {
    throw new UpstreamBlockedError(
      response.status,
      `Apple returned HTTP ${response.status} (${looksJson ? "json" : "non-JSON"}) for store ${anchorStore}: ${url}`
    );
  }

  if (!response.ok) {
    throw new Error(`Apple returned HTTP ${response.status} for store ${anchorStore}: ${text.slice(0, 200)}`);
  }

  const raw = JSON.parse(text);
  return { url, raw, parsed: parseFulfillment(raw, parts) };
}

// Checks every target store using as few requests as possible: query the
// anchors first, then query directly any target store that no anchor covered.
// Returns { stores: Map(storeId -> parsedStore), requests, errors, blocked }.
export async function scanStores(appleBase, parts, { anchors, targetStores, fetchOptions, concurrency = 2 } = {}) {
  const targets = new Set(targetStores);
  const seen = new Map();
  const errors = [];
  let requests = 0;
  let blocked = false;

  async function query(anchor) {
    requests += 1;
    try {
      const { parsed } = await fetchFulfillment(appleBase, anchor, parts, fetchOptions);
      for (const store of parsed.stores) {
        if (!seen.has(store.storeId)) seen.set(store.storeId, store);
      }
    } catch (err) {
      if (err instanceof UpstreamBlockedError) blocked = true;
      errors.push({ anchor, status: err.status || null, message: err.message || String(err) });
    }
  }

  async function runAll(list) {
    let index = 0;
    async function worker() {
      while (index < list.length && !blocked) {
        await query(list[index++]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  }

  await runAll(anchors && anchors.length ? anchors : [...targets].slice(0, 1));

  if (!blocked) {
    const missing = [...targets].filter((id) => !seen.has(id));
    await runAll(missing);
  }

  return { stores: seen, requests, errors, blocked };
}
