// Officeworks upstream client, shared by the Worker routes and the restock
// watcher (src/officeworks/watch-hub.mjs).

export const OW = {
  stores: "https://www.officeworks.com.au/contact-us?view=stores&format=json",
  productSearch:
    "https://www.officeworks.com.au/shop/ProductSearchView?pageSize=50&langId=-1&catalogId=-1&storeId=10151&searchTerm=",
  availabilityBase:
    "https://www.officeworks.com.au/catalogue-app/api/availabilities/store"
};

// Availability changes slowly enough that repeat checks within a minute can
// share one upstream call per store.
const AVAILABILITY_CACHE_SECONDS = 60;

export async function fetchJson(url, options = {}) {
  const cacheTtl = Number(options.cacheTtl || 0);
  const label = options.label || "upstream";
  const fetchImpl = options.fetchImpl || fetch;

  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0 OfficeworksStockChecker/10.0",
      "Referer": "https://www.officeworks.com.au/",
      "Origin": "https://www.officeworks.com.au"
    },
    cf:
      cacheTtl > 0
        ? { cacheTtl, cacheEverything: true }
        : { cacheTtl: 0 }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label} upstream HTTP ${response.status}: ${text.slice(0, 240)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 240)}`);
  }
}

// options.cache = false skips the shared 60 s cache (the watcher wants a
// fresh answer); options.fetchImpl is for tests.
export async function fetchAvailabilityRaw(storeId, postcode, sku, options = {}) {
  const url =
    `${OW.availabilityBase}/${encodeURIComponent(storeId)}` +
    `/postcode/${encodeURIComponent(postcode)}` +
    `?partNumbers=${encodeURIComponent(sku)}`;

  const cache = options.cache !== false && typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://stock-level-cache.local/availability-v1?store=${storeId}&postcode=${postcode}&sku=${sku}`);
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached.json();

  const raw = await fetchJson(url, {
    cacheTtl: 0,
    label: `current availability ${storeId}/${postcode}/${sku}`,
    fetchImpl: options.fetchImpl
  });

  if (cache) await cache.put(
    cacheKey,
    new Response(JSON.stringify(raw), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${AVAILABILITY_CACHE_SECONDS}`
      }
    })
  );

  return raw;
}

export function parseCurrentAvailability(raw, sku) {
  const items = Array.isArray(raw) ? raw : [raw];

  const target =
    items.find((item) => String(item && item.sku).toUpperCase() === sku) ||
    items[0] ||
    null;

  if (!target || typeof target !== "object") {
    return {
      qty: 0,
      inStoreQuantity: 0,
      clickAndCollectQuantity: 0,
      deliveryQuantity: 0,
      status: "no_stock",
      source: "current:empty-response",
      rawSignal: "No availability object returned"
    };
  }

  const inStoreQuantity = parseQty(target.inStoreQuantity) || 0;
  const clickAndCollectQuantity = parseQty(target.clickAndCollectQuantity) || 0;
  const deliveryQuantity = parseQty(target.deliveryQuantity) || 0;

  const qty = Math.max(inStoreQuantity, clickAndCollectQuantity);

  return {
    qty,
    inStoreQuantity,
    clickAndCollectQuantity,
    deliveryQuantity,
    status: qty > 0 ? "in_stock" : "no_stock",
    source:
      "current:catalogue-app/api/availabilities/store/{storeId}/postcode/{postcode}",
    rawSignal:
      `inStore=${inStoreQuantity}, clickAndCollect=${clickAndCollectQuantity}, delivery=${deliveryQuantity}`,
    collectEstimation: target.collectEstimation || "",
    deliveryEstimation: target.deliveryEstimation || "",
    quickCollect: target.isQuickCollectAvailable === true
  };
}

export function parseQty(value) {
  if (value === null || typeof value === "undefined") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const trimmed = value.trim();
    const direct = Number(trimmed);
    if (Number.isFinite(direct)) return direct;

    const match = trimmed.match(/\d+/);
    if (match) {
      const n = Number(match[0]);
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const i = index++;
      results[i] = await mapper(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner())
  );

  return results;
}
